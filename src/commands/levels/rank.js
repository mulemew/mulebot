'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const embeds = require('../../util/embeds');
const { number, progressBar, truncate } = require('../../util/text');
const { relative } = require('../../util/time');

/**
 * /rank and /profile.
 *
 * The rank card is drawn with text rather than an image. An image would need
 * canvas, which is a native module that fails to build on exactly the cheap
 * hosting this bot targets - and a text card copies, translates and renders on
 * every device without a font pack.
 */

const rank = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your level and XP')
    .addUserOption((o) => o.setName('user').setDescription('Whose rank to show')),
  category: 'levels',
  feature: 'leveling',
  cooldown: 5,

  async execute(ctx) {
    if (!ctx.settings.leveling.enabled) {
      return ctx.fail('Levelling is switched off here. An admin can enable it with `/config leveling toggle`.');
    }

    const target = ctx.userOpt('user', true);
    if (target.bot) return ctx.fail('Bots do not earn XP.');

    const leveling = ctx.bot.features.leveling;
    const record = ctx.record(target.id);

    if (!record.xp) {
      return ctx.fail(
        target.id === ctx.user.id
          ? 'You have not earned any XP yet. Send a few messages and try again.'
          : `**${target.username}** has not earned any XP yet.`,
      );
    }

    const board = leveling.leaderboard(ctx.i.guildId, 10_000);
    const position = board.findIndex((e) => e.userId === target.id) + 1;

    const embed = leveling.renderCard(target, record, position, board.length);

    // Show what the next reward role is, which is the thing people actually
    // want to know when they check their rank.
    const rewards = ctx.settings.leveling.rewards || {};
    const upcoming = Object.keys(rewards)
      .map(Number)
      .filter((l) => l > leveling.levelFromXp(record.xp))
      .sort((a, b) => a - b)[0];

    if (upcoming) {
      const roleNames = (rewards[String(upcoming)] || []).map((id) => `<@&${id}>`).join(' ');
      embed.addFields({ name: `Next reward at level ${upcoming}`, value: roleNames || '(role deleted)' });
    }

    if (record.xpBoostUntil && record.xpBoostUntil > Date.now()) {
      embed.addFields({ name: '⚡ XP boost active', value: `Double XP until ${relative(record.xpBoostUntil)}` });
    }

    return ctx.send({ embeds: [embed] });
  },
};

const profile = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Your server profile')
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription('View a profile')
        .addUserOption((o) => o.setName('user').setDescription('Whose profile')),
    )
    .addSubcommand((s) =>
      s
        .setName('bio')
        .setDescription('Set your bio')
        .addStringOption((o) => o.setName('text').setDescription('Up to 200 characters, leave empty to clear')),
    )
    .addSubcommand((s) =>
      s
        .setName('color')
        .setDescription('Set your profile colour (needs a colour token from the shop)')
        .addStringOption((o) => o.setName('value').setDescription('Hex or colour name').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('rep')
        .setDescription('Give someone a reputation point, once a day')
        .addUserOption((o) => o.setName('user').setDescription('Who to thank').setRequired(true)),
    ),
  category: 'levels',
  cooldown: 5,

  async execute(ctx) {
    const colors = require('../../data/colors');

    switch (ctx.sub) {
      case 'view': {
        const target = ctx.userOpt('user', true);
        const record = ctx.record(target.id);
        const leveling = ctx.bot.features.leveling;
        const progress = leveling.progress(record.xp);

        const member = await ctx.guild.members.fetch(target.id).catch(() => null);

        const embed = embeds
          .base(target.tag, record.bio || '*No bio set. Use `/profile bio`.*', record.color || undefined)
          .setThumbnail(target.displayAvatarURL({ size: 256 }));

        if (ctx.settings.leveling.enabled) {
          embed.addFields({
            name: `Level ${progress.level}`,
            value: `\`${progressBar(progress.ratio, 16)}\` ${number(progress.current)}/${number(progress.needed)} XP`,
          });
        }
        if (ctx.settings.economy.enabled) {
          const balance = ctx.bot.features.economy.balance(ctx.i.guildId, target.id);
          embed.addFields({ name: 'Balance', value: ctx.money(balance.total), inline: true });
        }

        embed.addFields(
          { name: 'Messages', value: number(record.messages), inline: true },
          { name: 'Reputation', value: number(record.reputation), inline: true },
          {
            name: 'Games',
            value: `${number(record.games.won)}W / ${number(record.games.lost)}L / ${number(record.games.drawn)}D`,
            inline: true,
          },
        );

        if (record.voiceMinutes) {
          embed.addFields({
            name: 'Voice time',
            value: `${number(Math.floor(record.voiceMinutes / 60))}h ${record.voiceMinutes % 60}m`,
            inline: true,
          });
        }
        if (record.badges?.length) {
          const icons = { star: '🌟', crown: '👑' };
          embed.addFields({ name: 'Badges', value: record.badges.map((b) => icons[b] || `\`${b}\``).join(' ') });
        }
        if (member?.joinedTimestamp) {
          embed.setFooter({ text: `Member since ${new Date(member.joinedTimestamp).toDateString()}` });
        }

        return ctx.send({ embeds: [embed] });
      }

      case 'bio': {
        const record = ctx.record();
        const text = ctx.str('text');
        record.bio = text ? truncate(text, 200) : '';
        ctx.save();
        return ctx.ok(text ? 'Bio updated' : 'Bio cleared', record.bio || undefined, { ephemeral: true });
      }

      case 'color': {
        const record = ctx.record();
        if (!(record.colorTokens > 0)) {
          return ctx.fail('You need a colour token. Buy one with `/buy item:name_color`, then `/use item:name_color`.');
        }
        const value = colors.parse(ctx.str('value'));
        if (value === null) return ctx.fail('I could not read that colour. Try a hex code like `#ff8800`.');

        record.color = value;
        record.colorTokens--;
        ctx.save();
        return ctx.ok('Colour set', `Your profile is now ${colors.toHex(value)}.`, { ephemeral: true });
      }

      case 'rep': {
        const target = ctx.userOpt('user');
        if (target.id === ctx.user.id) return ctx.fail('You cannot give yourself reputation.');
        if (target.bot) return ctx.fail('Bots do not need the validation.');

        const giver = ctx.record();
        const cooldown = 86_400_000;
        if (Date.now() - (giver.lastRepAt || 0) < cooldown) {
          return ctx.fail(`You can give reputation again ${relative(giver.lastRepAt + cooldown)}.`);
        }

        giver.lastRepAt = Date.now();
        const receiver = ctx.record(target.id);
        receiver.reputation = (receiver.reputation || 0) + 1;
        ctx.save();

        return ctx.send({
          embeds: [
            embeds.success(
              'Reputation given',
              `<@${ctx.user.id}> gave <@${target.id}> a reputation point. They now have **${number(receiver.reputation)}**.`,
            ),
          ],
          allowedMentions: { users: [target.id] },
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const levelAdmin = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Adjust member XP (staff only)')
    .addSubcommand((s) =>
      s
        .setName('give')
        .setDescription('Add XP to a member')
        .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('How much').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('take')
        .setDescription('Remove XP from a member')
        .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('How much').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set a member to an exact level')
        .addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
        .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Wipe a member\'s XP, or everyone\'s')
        .addUserOption((o) => o.setName('user').setDescription('Leave empty to reset the whole server')),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'levels',
  feature: 'leveling',
  userPerms: [PermissionFlagsBits.ManageGuild],
  cooldown: 3,

  async execute(ctx) {
    const leveling = ctx.bot.features.leveling;

    if (ctx.sub === 'reset') {
      const target = ctx.userOpt('user');
      if (target) {
        leveling.setXp(ctx.i.guildId, target.id, 0);
        return ctx.ok('Reset', `<@${target.id}> is back to level 0.`);
      }

      // A full wipe is destructive and irreversible, so it says exactly what it
      // did rather than a bare "done".
      let count = 0;
      for (const [userId, record] of ctx.db.members(ctx.i.guildId)) {
        if (!record.xp) continue;
        record.xp = 0;
        record.level = 0;
        count++;
        void userId;
      }
      ctx.save();
      return ctx.ok('Server XP reset', `Cleared XP for **${number(count)}** member(s). This cannot be undone.`);
    }

    const target = ctx.userOpt('user');
    if (target.bot) return ctx.fail('Bots do not have XP.');

    if (ctx.sub === 'set') {
      const level = ctx.int('level');
      const xp = leveling.totalXpFor(level);
      leveling.setXp(ctx.i.guildId, target.id, xp);
      return ctx.ok('Level set', `<@${target.id}> is now level **${level}** (${number(xp)} XP).`);
    }

    const amount = ctx.int('amount') * (ctx.sub === 'take' ? -1 : 1);
    const record = leveling.addXp(ctx.i.guildId, target.id, amount);
    return ctx.ok(
      ctx.sub === 'give' ? 'XP added' : 'XP removed',
      `<@${target.id}> now has **${number(record.xp)}** XP (level ${record.level}).`,
    );
  },
};

module.exports = [rank, profile, levelAdmin];
