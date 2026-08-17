'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const rng = require('../../util/random');
const flavor = require('../../data/flavor');
const { truncate, number, progressBar } = require('../../util/text');

/**
 * Light entertainment: /roll, /pick, /8ball, /fun, /ship.
 *
 * One editorial decision runs through all of it: nothing here produces content
 * that a moderator has to clean up. The "roast" list is self-deprecating and
 * absurd rather than personal, /ship is explicitly labelled as a random number,
 * and no command reproduces user text back into the channel with mentions
 * intact.
 */

const roll = {
  data: new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll dice in NdM notation')
    .addStringOption((o) => o.setName('dice').setDescription('Format NdM, e.g. 2d6 or d20. Defaults to 1d6'))
    .addIntegerOption((o) => o.setName('modifier').setDescription('Add or subtract from the total'))
    .addBooleanOption((o) => o.setName('advantage').setDescription('Roll twice and keep the higher total')),
  category: 'fun',
  cooldown: 3,
  guildOnly: false,
  examples: ['/roll dice:2d6', '/roll dice:d20 modifier:5 advantage:true'],

  async execute(ctx) {
    const raw = (ctx.str('dice') || '1d6').trim().toLowerCase();
    const match = raw.match(/^(\d{1,2})?d(\d{1,4})$/);
    if (!match) return ctx.fail('Use `NdM`, for example `2d6`, `d20` or `4d10`.');

    const count = Number(match[1] || 1);
    const sides = Number(match[2]);
    if (count < 1 || count > 25) return ctx.fail('Roll between 1 and 25 dice.');
    if (sides < 2 || sides > 1000) return ctx.fail('Dice must have between 2 and 1000 sides.');

    const modifier = ctx.int('modifier', 0);
    const advantage = ctx.bool('advantage');

    const first = rng.dice(count, sides);
    const second = advantage ? rng.dice(count, sides) : null;
    const chosen = second && second.total > first.total ? second : first;

    const lines = [`**${chosen.total + modifier}**`];
    if (count > 1) lines.push(`Rolls: ${chosen.rolls.join(' + ')} = ${chosen.total}`);
    if (modifier) lines.push(`Modifier: ${modifier > 0 ? '+' : ''}${modifier}`);
    if (advantage) {
      lines.push(`Advantage: ${first.total} vs ${second.total} — kept **${chosen.total}**`);
    }

    // A natural 20 or 1 on a d20 is the whole point of rolling a d20.
    if (sides === 20 && count === 1) {
      if (chosen.rolls[0] === 20) lines.push('\n🎉 Natural 20.');
      else if (chosen.rolls[0] === 1) lines.push('\n💀 Natural 1.');
    }

    return ctx.send({
      embeds: [embeds.base(`Rolling ${count}d${sides}`, lines.join('\n'))],
    });
  },
};

const pick = {
  data: new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Pick one option at random')
    .addStringOption((o) =>
      o.setName('options').setDescription('Separate with commas or |, e.g. pizza, sushi, tacos').setRequired(true),
    )
    .addIntegerOption((o) => o.setName('count').setDescription('Pick several at once').setMinValue(1).setMaxValue(10)),
  category: 'fun',
  cooldown: 3,
  guildOnly: false,

  async execute(ctx) {
    // Commas and pipes are treated as separators; spaces only when neither is
    // present, so "fish and chips, pizza" works the way it reads.
    const raw = ctx.str('options');
    const separator = /[,|]/.test(raw) ? /[,|]/ : /\s+/;
    const list = raw
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);

    if (list.length < 2) return ctx.fail('Give me at least 2 options, separated by commas or `|`.');
    if (list.length > 50) return ctx.fail('At most 50 options.');

    const count = Math.min(ctx.int('count', 1), list.length);
    const chosen = rng.sample(list, count);

    return ctx.send({
      embeds: [
        embeds
          .base(
            count === 1 ? 'I pick' : `I pick ${count}`,
            chosen.map((c) => `**${truncate(c, 200)}**`).join('\n'),
          )
          .setFooter({ text: `Chosen from ${list.length} options` }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

const eightball = {
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Ask the magic 8-ball a yes/no question')
    .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true)),
  category: 'fun',
  cooldown: 3,
  guildOnly: false,

  async execute(ctx) {
    const question = ctx.str('question');

    // Weighted so the answer is not a uniform coin flip across three buckets:
    // roughly 45% positive, 20% neutral, 35% negative, which is what the
    // original toy actually does.
    const bucket = rng.weighted([
      { weight: 45, list: flavor.EIGHTBALL.positive, color: embeds.theme.success },
      { weight: 20, list: flavor.EIGHTBALL.neutral, color: embeds.theme.warning },
      { weight: 35, list: flavor.EIGHTBALL.negative, color: embeds.theme.danger },
    ]);

    return ctx.send({
      embeds: [
        embeds.base(
          '🎱 Magic 8-ball',
          `**Q:** ${truncate(question, 250)}\n**A:** ${rng.pick(bucket.list)}`,
          bucket.color,
        ),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

const fun = {
  data: new SlashCommandBuilder()
    .setName('fun')
    .setDescription('Assorted small distractions')
    .addSubcommand((s) => s.setName('fact').setDescription('A random fact'))
    .addSubcommand((s) => s.setName('quote').setDescription('A programming quote'))
    .addSubcommand((s) => s.setName('roast').setDescription('A gentle, universally applicable roast'))
    .addSubcommand((s) =>
      s
        .setName('compliment')
        .setDescription('A genuine compliment')
        .addUserOption((o) => o.setName('user').setDescription('Who to compliment')),
    )
    .addSubcommand((s) => s.setName('wyr').setDescription('Would you rather…'))
    .addSubcommand((s) => s.setName('truth').setDescription('A truth question'))
    .addSubcommand((s) => s.setName('dare').setDescription('A dare'))
    .addSubcommand((s) => s.setName('coinflip').setDescription('Flip a coin')),
  category: 'fun',
  cooldown: 3,
  guildOnly: false,

  async execute(ctx) {
    switch (ctx.sub) {
      case 'fact':
        return ctx.send({ embeds: [embeds.base('Did you know', rng.pick(flavor.FACTS))] });

      case 'quote': {
        const quote = rng.pick(flavor.QUOTES);
        return ctx.send({
          embeds: [embeds.base(null, `> ${quote.text}\n\n— **${quote.by}**`)],
        });
      }

      case 'roast':
        return ctx.send({
          embeds: [
            embeds
              .base('Roast', rng.pick(flavor.ROASTS))
              .setFooter({ text: 'Generic and applies to everyone, including me.' }),
          ],
        });

      case 'compliment': {
        const target = ctx.userOpt('user');
        const body = rng.pick(flavor.COMPLIMENTS);
        return ctx.send({
          content: target ? `<@${target.id}>` : undefined,
          embeds: [embeds.base('Compliment', body, embeds.theme.success)],
          allowedMentions: target ? { users: [target.id] } : { parse: [] },
        });
      }

      case 'wyr': {
        const [a, b] = rng.pick(flavor.WOULD_YOU_RATHER);
        return ctx.send({
          embeds: [embeds.base('Would you rather…', `🅰️ ${a}\n\n**or**\n\n🅱️ ${b}`)],
        });
      }

      case 'truth':
        return ctx.send({ embeds: [embeds.base('Truth', rng.pick(flavor.TRUTHS))] });

      case 'dare':
        return ctx.send({ embeds: [embeds.base('Dare', rng.pick(flavor.DARES))] });

      case 'coinflip': {
        const heads = rng.chance(0.5);
        return ctx.send({
          embeds: [
            embeds.base(
              heads ? '🪙 Heads' : '🪙 Tails',
              null,
              heads ? embeds.theme.gold : embeds.theme.neutral,
            ),
          ],
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

const ship = {
  data: new SlashCommandBuilder()
    .setName('ship')
    .setDescription('Rate the compatibility of two people, entirely unscientifically')
    .addUserOption((o) => o.setName('first').setDescription('First person').setRequired(true))
    .addUserOption((o) => o.setName('second').setDescription('Second person, defaults to you')),
  category: 'fun',
  cooldown: 5,

  async execute(ctx) {
    const first = ctx.userOpt('first');
    const second = ctx.userOpt('second') || ctx.user;

    if (first.id === second.id) return ctx.fail('Pick two different people.');

    // Deterministic from the pair of ids, so the same two people always get the
    // same score. A number that changes on every invocation is not a joke, it
    // is just noise - and people do re-run it to check.
    const seed = [first.id, second.id].sort().join(':');
    const score = Math.floor(rng.seeded(seed)() * 101);
    const band = flavor.SHIP_BANDS.find((b) => score <= b.max) || flavor.SHIP_BANDS[0];

    // A "ship name" from the halves of both names.
    const nameA = first.username.slice(0, Math.ceil(first.username.length / 2));
    const nameB = second.username.slice(Math.floor(second.username.length / 2));

    return ctx.send({
      embeds: [
        embeds
          .base(
            `${band.emoji} ${nameA}${nameB}`,
            [
              `<@${first.id}>  ×  <@${second.id}>`,
              '',
              `\`${progressBar(score / 100, 20)}\` **${number(score)}%**`,
              '',
              band.text,
            ].join('\n'),
          )
          .setFooter({ text: 'Derived from the two user IDs. Stable, meaningless, and not advice.' }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

module.exports = [roll, pick, eightball, fun, ship];
