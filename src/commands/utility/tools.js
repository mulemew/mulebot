'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const mathexpr = require('../../util/mathexpr');
const codec = require('../../data/codec');
const colors = require('../../data/colors');
const { parseDuration, timestamp, fullTimestamp } = require('../../util/time');
const { truncate, codeBlock, inlineCode, humanList } = require('../../util/text');

/**
 * Text and number tools: /math, /encode, /decode, /color, /timestamp.
 *
 * These are the commands where a naive implementation is actively dangerous.
 * /math does not use eval - see util/mathexpr.js for the parser and why.
 * /encode is explicit that none of its transformations are encryption, because
 * base64 looks like secrecy to people meeting it for the first time.
 */

const math = {
  data: new SlashCommandBuilder()
    .setName('math')
    .setDescription('Evaluate an arithmetic expression')
    .addStringOption((o) => o.setName('expression').setDescription('e.g. (3 + 4) * 2^5, sqrt(144), 10!').setRequired(true)),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,
  examples: ['/math expression:2^10', '/math expression:sqrt(2) * pi'],

  async execute(ctx) {
    const source = ctx.str('expression');
    const result = mathexpr.evaluate(source);

    if (!result.ok) {
      return ctx.fail(
        `${result.error}\n\nSupported: \`+ - * / % ^ !\`, parentheses, and ${humanList(
          Object.keys(mathexpr.FUNCTIONS).slice(0, 8).map((f) => `\`${f}()\``),
        )} among others. Constants: ${Object.keys(mathexpr.CONSTANTS).map((c) => `\`${c}\``).join(', ')}.`,
      );
    }

    return ctx.send({
      embeds: [
        embeds
          .base('Result', `${codeBlock(truncate(source, 400))}\n**${mathexpr.format(result.value)}**`)
          .setFooter({ text: 'Parsed by a restricted arithmetic parser — no code is executed' }),
      ],
    });
  },
};

const encode = {
  data: new SlashCommandBuilder()
    .setName('encode')
    .setDescription('Transform text: base64, hex, binary, morse and more')
    .addStringOption((o) =>
      o
        .setName('method')
        .setDescription('How to transform it')
        .setRequired(true)
        .addChoices(...codec.ENCODINGS.map((e) => ({ name: e, value: e }))),
    )
    .addStringOption((o) => o.setName('text').setDescription('The text to transform').setRequired(true)),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,

  async execute(ctx) {
    const method = ctx.str('method');
    const text = ctx.str('text');

    if (text.length > 1000) return ctx.fail('Keep the input under 1000 characters.');

    const result = codec.encode(method, text);
    if (!result.ok) return ctx.fail(result.error);

    return ctx.send({
      embeds: [
        embeds
          .base(`Encoded — ${method}`, codeBlock(truncate(result.value, 1900)))
          .addFields({ name: 'Input', value: codeBlock(truncate(text, 500)) })
          .setFooter({
            text: 'These are encodings, not encryption. Anyone can reverse them — never put a secret through this.',
          }),
      ],
    });
  },
};

const decode = {
  data: new SlashCommandBuilder()
    .setName('decode')
    .setDescription('Reverse an encoding back to plain text')
    .addStringOption((o) =>
      o
        .setName('method')
        .setDescription('Which encoding it is in')
        .setRequired(true)
        .addChoices(...codec.DECODINGS.map((e) => ({ name: e, value: e }))),
    )
    .addStringOption((o) => o.setName('text').setDescription('The encoded text').setRequired(true)),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,

  async execute(ctx) {
    const method = ctx.str('method');
    const text = ctx.str('text');

    if (text.length > 2000) return ctx.fail('Keep the input under 2000 characters.');

    const result = codec.decode(method, text);
    if (!result.ok) return ctx.fail(result.error);

    // The decoded output is echoed inside a code block with mentions stripped,
    // so a crafted payload cannot ping the server through this command.
    return ctx.send({
      embeds: [
        embeds
          .base(`Decoded — ${method}`, codeBlock(truncate(result.value, 1900)))
          .addFields({ name: 'Input', value: codeBlock(truncate(text, 500)) }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

const color = {
  data: new SlashCommandBuilder()
    .setName('color')
    .setDescription('Inspect a colour in every notation')
    .addStringOption((o) =>
      o.setName('value').setDescription('#ff0000, red, rgb(255,0,0), hsl(0,100%,50%), 16711680, or "random"').setRequired(true),
    ),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,
  examples: ['/color value:#5865f2', '/color value:blurple', '/color value:random'],

  async execute(ctx) {
    const input = ctx.str('value');
    const value = colors.parse(input);

    if (value === null) {
      return ctx.fail(
        `I could not read \`${truncate(input, 60)}\` as a colour.\n\nTry \`#ff0000\`, \`rgb(255, 0, 0)\`, \`hsl(0, 100%, 50%)\`, a decimal like \`16711680\`, \`random\`, or a name such as \`crimson\`.`,
      );
    }

    const nearest = colors.nearestName(value);
    const white = colors.contrast(value, 0xffffff);
    const black = colors.contrast(value, 0x000000);

    // A 1×1 PNG service would be an external dependency, so the swatch is the
    // embed's own colour bar - which is exactly what a role colour looks like.
    return ctx.send({
      embeds: [
        embeds
          .base(colors.toHex(value).toUpperCase(), null, value)
          .addFields(
            { name: 'Hex', value: inlineCode(colors.toHex(value)), inline: true },
            { name: 'Decimal', value: inlineCode(String(value)), inline: true },
            { name: 'Nearest name', value: nearest.exact ? `**${nearest.name}** (exact)` : nearest.name, inline: true },
            { name: 'RGB', value: inlineCode(colors.rgbString(value)), inline: true },
            { name: 'HSL', value: inlineCode(colors.hslString(value)), inline: true },
            { name: 'Complement', value: inlineCode(colors.toHex(colors.complement(value))), inline: true },
            {
              name: 'Readability',
              value:
                `White text: ${white.toFixed(1)}:1 ${white >= 4.5 ? '✅' : '❌'}\n` +
                `Black text: ${black.toFixed(1)}:1 ${black >= 4.5 ? '✅' : '❌'}\n` +
                '*4.5:1 is the WCAG AA minimum for normal text.*',
            },
            {
              name: 'Shades',
              value: colors.shades(value).map((s) => inlineCode(colors.toHex(s))).join(' '),
            },
          )
          .setFooter({ text: 'The bar on the left of this embed is the colour itself' }),
      ],
    });
  },
};

const timestampCmd = {
  data: new SlashCommandBuilder()
    .setName('timestamp')
    .setDescription('Build a Discord timestamp that renders in everyone\'s own timezone')
    .addStringOption((o) =>
      o.setName('when').setDescription('A delay like 2h30m, or an ISO date like 2026-12-25T18:00').setRequired(true),
    ),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,
  examples: ['/timestamp when:3h', '/timestamp when:2026-12-25T18:00'],

  async execute(ctx) {
    const input = ctx.str('when').trim();

    // Two accepted forms: a relative duration, or something Date can parse.
    let target = null;
    const asDuration = parseDuration(input);
    if (asDuration !== null) {
      target = Date.now() + asDuration;
    } else {
      const parsed = Date.parse(input);
      if (!Number.isNaN(parsed)) target = parsed;
    }

    if (target === null) {
      return ctx.fail(
        'I could not read that as a time.\n\nUse a delay like `90m`, `2h30m`, `3d`, or an absolute date like `2026-12-25T18:00`.',
      );
    }

    const styles = [
      ['t', 'Short time'],
      ['T', 'Long time'],
      ['d', 'Short date'],
      ['D', 'Long date'],
      ['f', 'Short date/time'],
      ['F', 'Long date/time'],
      ['R', 'Relative'],
    ];

    const rows = styles.map(([style, label]) => {
      const code = timestamp(target, style);
      return `**${label}** — \`${code}\` → ${code}`;
    });

    return ctx.send({
      embeds: [
        embeds
          .base('Discord timestamps', rows.join('\n'))
          .setFooter({ text: 'Copy the code into any message; every reader sees it in their own timezone.' })
          .addFields({ name: 'Resolved to', value: fullTimestamp(target) }),
      ],
    });
  },
};

module.exports = [math, encode, decode, color, timestampCmd];
