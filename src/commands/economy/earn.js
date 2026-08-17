'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const perms = require('../../util/perms');
const { relative, formatDuration } = require('../../util/time');
const { number, progressBar } = require('../../util/text');

/**
 * Earning and moving money: /balance, /daily, /weekly, /work, /crime, /rob,
 * /pay, /bank.
 *
 * Every one of these delegates the actual arithmetic to features/economy.js.
 * That is the whole point of the split: a command file that mutates balances
 * directly is one missing check away from minting currency, and once a server's
 * economy has been inflated there is no clean way back.
 */

const balance = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show your wallet and bank')
    .addUserOption((o) => o.setName('user').setDescription('Whose balance to show')),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async execute(ctx) {
    const target = ctx.userOpt('user', true);
    if (target.bot) return ctx.fail('Bots do not have wallets.');

    const economy = ctx.bot.features.economy;
    const bal = economy.balance(ctx.i.guildId, target.id);
    const record = ctx.record(target.id);

    const board = economy.leaderboard(ctx.i.guildId, 10_000);
    const rank = board.findIndex((e) => e.userId === target.id) + 1;

    const cooldowns = ['daily', 'weekly', 'work', 'crime', 'rob']
      .map((kind) => {
        const left = economy.cooldownLeft(ctx.i.guildId, target.id, kind);
        return `\`/${kind}\` ${left > 0 ? relative(Date.now() + left) : '✅ ready'}`;
      })
      .join('\n');

    return ctx.send({
      embeds: [
        embeds
          .base(`${target.username}'s balance`)
          .setThumbnail(target.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: 'Wallet', value: ctx.money(bal.wallet), inline: true },
            { name: 'Bank', value: ctx.money(bal.bank), inline: true },
            { name: 'Total', value: ctx.money(bal.total), inline: true },
            { name: 'Rank', value: rank ? `#${rank} of ${board.length}` : 'unranked', inline: true },
            { name: 'Daily streak', value: `${number(record.dailyStreak || 0)} day(s)`, inline: true },
            { name: 'Items held', value: number(Object.values(record.inventory || {}).reduce((a, b) => a + b, 0)), inline: true },
            { name: 'Availability', value: cooldowns },
          )
          .setFooter({ text: 'Coins in the bank cannot be stolen with /rob' }),
      ],
    });
  },
};

/** Shared handler for the three "click for coins" commands. */
async function payout(ctx, kind) {
  const economy = ctx.bot.features.economy;
  const result =
    kind === 'daily'
      ? economy.claimDaily(ctx.i.guildId, ctx.user.id)
      : kind === 'weekly'
        ? economy.claimWeekly(ctx.i.guildId, ctx.user.id)
        : kind === 'work'
          ? economy.work(ctx.i.guildId, ctx.user.id)
          : economy.crime(ctx.i.guildId, ctx.user.id);

  if (!result.ok) {
    return ctx.fail(
      `Not yet — try again ${relative(Date.now() + result.retryIn)} (${formatDuration(result.retryIn)} from now).`,
    );
  }

  const bal = economy.balance(ctx.i.guildId, ctx.user.id);

  if (kind === 'daily') {
    return ctx.send({
      embeds: [
        embeds
          .success('Daily claimed', `${result.message.replace('{amount}', `**${ctx.money(result.amount)}**`)}`)
          .addFields(
            { name: 'Streak', value: `${number(result.streak)} day(s)`, inline: true },
            { name: 'Streak bonus', value: `+${result.bonusPercent}%`, inline: true },
            { name: 'Wallet', value: ctx.money(bal.wallet), inline: true },
          )
          .setFooter({ text: 'Claim again after midnight to keep the streak going' }),
      ],
    });
  }

  if (kind === 'weekly') {
    return ctx.send({
      embeds: [
        embeds
          .success('Weekly claimed', `You received **${ctx.money(result.amount)}**.`)
          .addFields({ name: 'Wallet', value: ctx.money(bal.wallet), inline: true }),
      ],
    });
  }

  if (kind === 'work') {
    return ctx.send({
      embeds: [
        embeds
          .success('Shift complete', result.message)
          .addFields({ name: 'Wallet', value: ctx.money(bal.wallet), inline: true }),
      ],
    });
  }

  // crime
  return ctx.send({
    embeds: [
      (result.success ? embeds.success : embeds.error)(
        result.success ? 'It worked' : 'It went wrong',
        result.message,
      ).addFields({ name: 'Wallet', value: ctx.money(bal.wallet), inline: true }),
    ],
  });
}

const daily = {
  data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins'),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,
  execute: (ctx) => payout(ctx, 'daily'),
};

const weekly = {
  data: new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly coins'),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,
  execute: (ctx) => payout(ctx, 'weekly'),
};

const work = {
  data: new SlashCommandBuilder().setName('work').setDescription('Work a shift for coins'),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,
  execute: (ctx) => payout(ctx, 'work'),
};

const crime = {
  data: new SlashCommandBuilder().setName('crime').setDescription('Attempt a crime — it can go badly'),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,
  execute: (ctx) => payout(ctx, 'crime'),
};

const rob = {
  data: new SlashCommandBuilder()
    .setName('rob')
    .setDescription('Try to rob another member — risky, and they will know')
    .addUserOption((o) => o.setName('user').setDescription('Who to rob').setRequired(true)),
  category: 'economy',
  feature: 'economy',
  cooldown: 5,

  async execute(ctx) {
    const target = ctx.userOpt('user');
    if (target.id === ctx.user.id) return ctx.fail('You cannot rob yourself.');
    if (target.bot) return ctx.fail('Bots carry no coins.');

    const member = await ctx.guild.members.fetch(target.id).catch(() => null);
    if (!member) return ctx.tfail('err.memberNotFound');

    const result = ctx.bot.features.economy.rob(ctx.i.guildId, ctx.user.id, target.id, target.username);

    if (!result.ok) {
      if (result.retryIn) {
        return ctx.fail(`Lie low for a while — try again ${relative(Date.now() + result.retryIn)}.`);
      }
      return ctx.fail(result.reason);
    }

    if (result.blocked) {
      return ctx.send({
        embeds: [embeds.warning('Blocked', result.reason)],
        allowedMentions: { parse: [] },
      });
    }

    // The victim is always told: a silent transfer of their coins would be a
    // support ticket, not a game mechanic.
    return ctx.send({
      content: `<@${target.id}>`,
      embeds: [
        (result.success ? embeds.success : embeds.error)(
          result.success ? 'Robbery successful' : 'Robbery failed',
          result.message,
        ),
      ],
      allowedMentions: { users: [target.id] },
    });
  },
};

const pay = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Send coins to another member')
    .addUserOption((o) => o.setName('user').setDescription('Who to pay').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('How much').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('note').setDescription('A note shown to them')),
  category: 'economy',
  feature: 'economy',
  cooldown: 5,

  async execute(ctx) {
    const target = ctx.userOpt('user');
    const amount = ctx.int('amount');

    if (target.bot) return ctx.fail('Bots cannot be paid.');

    const member = await ctx.guild.members.fetch(target.id).catch(() => null);
    if (!member) return ctx.tfail('err.memberNotFound');

    const result = ctx.bot.features.economy.transfer(ctx.i.guildId, ctx.user.id, target.id, amount);
    if (!result.ok) return ctx.fail(result.reason);

    const embed = embeds.success(
      'Payment sent',
      `<@${ctx.user.id}> sent **${ctx.money(amount)}** to <@${target.id}>.`,
    );
    const note = ctx.str('note');
    if (note) embed.addFields({ name: 'Note', value: note.slice(0, 500) });

    return ctx.send({ embeds: [embed], allowedMentions: { users: [target.id] } });
  },
};

const bank = {
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Move coins between your wallet and your bank')
    .addSubcommand((s) =>
      s
        .setName('deposit')
        .setDescription('Move coins into the bank, where they cannot be robbed')
        .addStringOption((o) => o.setName('amount').setDescription('A number, or "all"').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('withdraw')
        .setDescription('Move coins back into your wallet')
        .addStringOption((o) => o.setName('amount').setDescription('A number, or "all"').setRequired(true)),
    ),
  category: 'economy',
  feature: 'economy',
  cooldown: 3,

  async execute(ctx) {
    const economy = ctx.bot.features.economy;
    const bal = economy.balance(ctx.i.guildId, ctx.user.id);
    const raw = ctx.str('amount').trim().toLowerCase();
    const direction = ctx.sub;

    const available = direction === 'deposit' ? bal.wallet : bal.bank;
    const amount = raw === 'all' || raw === 'max' ? available : Number(raw.replace(/[,_\s]/g, ''));

    if (!Number.isFinite(amount) || amount <= 0) return ctx.tfail('err.badNumber');
    if (amount > available) {
      return ctx.fail(
        `You only have ${ctx.money(available)} ${direction === 'deposit' ? 'in your wallet' : 'in the bank'}.`,
      );
    }

    if (!economy.move(ctx.i.guildId, ctx.user.id, Math.floor(amount), direction)) {
      return ctx.fail('That transfer could not be completed.');
    }

    const after = economy.balance(ctx.i.guildId, ctx.user.id);
    const ratio = after.total ? after.bank / after.total : 0;

    return ctx.ok(
      direction === 'deposit' ? 'Deposited' : 'Withdrawn',
      [
        `Moved **${ctx.money(Math.floor(amount))}**.`,
        '',
        `Wallet: ${ctx.money(after.wallet)}`,
        `Bank: ${ctx.money(after.bank)}`,
        '',
        `\`${progressBar(ratio, 18)}\` ${Math.round(ratio * 100)}% banked`,
      ].join('\n'),
    );
  },
};

void perms;
module.exports = [balance, daily, weekly, work, crime, rob, pay, bank];
