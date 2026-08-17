'use strict';

const embeds = require('../util/embeds');
const rng = require('../util/random');
const mathexpr = require('../util/mathexpr');
const flavor = require('../data/flavor');
const { number, closest, truncate, progressBar } = require('../util/text');
const { fullTimestamp, formatDuration } = require('../util/time');

/**
 * Legacy prefix commands.
 *
 * Slash commands are the supported interface; this bridge exists because plenty
 * of servers still have muscle memory for "!rank" and because a text command
 * works in situations a slash command does not (a phone with a flaky client, a
 * channel where the bot's commands were hidden by a permission override).
 *
 * It is deliberately a *subset*: read-only and self-service commands only.
 * Nothing here can kick, ban or move money between members. Moderation through
 * a text command has no permission scoping from Discord's side, which means the
 * bot would have to reimplement it, and getting that subtly wrong is how bots
 * end up as privilege-escalation vectors.
 *
 * Requires the MESSAGE CONTENT privileged intent; without it the bot cannot see
 * message text at all and this feature disables itself with one log line.
 */

const MAX_ARG_LENGTH = 500;

function init(bot) {
  const log = bot.log.child('prefix');
  let warned = false;

  /** name -> { aliases, description, run } */
  const commands = new Map();

  function define(name, { aliases = [], description, run }) {
    commands.set(name, { name, aliases, description, run });
    for (const alias of aliases) commands.set(alias, commands.get(name));
  }

  // ---------- command table ----------

  define('ping', {
    description: 'Show the gateway latency',
    run: async (message) => {
      const sent = await message.reply({ content: 'Measuring…', allowedMentions: { repliedUser: false } });
      const rtt = sent.createdTimestamp - message.createdTimestamp;
      await sent.edit({
        content: null,
        embeds: [embeds.base('Pong', `Round trip **${rtt}ms**\nWebSocket **${Math.round(bot.client.ws.ping)}ms**`)],
      });
    },
  });

  define('help', {
    aliases: ['commands', 'h'],
    description: 'List the text commands',
    run: async (message, args, { prefix }) => {
      const unique = [...new Set([...commands.values()])];
      if (args[0]) {
        const found = commands.get(args[0].toLowerCase());
        if (found) {
          return message.reply({
            embeds: [embeds.base(`${prefix}${found.name}`, found.description)],
            allowedMentions: { repliedUser: false },
          });
        }
      }
      const lines = unique.map(
        (c) => `\`${prefix}${c.name}\`${c.aliases.length ? ` (${c.aliases.map((a) => prefix + a).join(', ')})` : ''} — ${c.description}`,
      );
      return message.reply({
        embeds: [
          embeds
            .base('Text commands', lines.join('\n'))
            .setFooter({ text: 'Everything else lives under / — try /help for the full list.' }),
        ],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('avatar', {
    aliases: ['av', 'pfp'],
    description: 'Show a user avatar',
    run: async (message) => {
      const user = message.mentions.users.first() || message.author;
      const url = user.displayAvatarURL({ size: 1024 });
      return message.reply({
        embeds: [embeds.base(`${user.tag}`, `[Open full size](${url})`).setImage(url)],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('userinfo', {
    aliases: ['ui', 'whois'],
    description: 'Show information about a member',
    run: async (message) => {
      const user = message.mentions.users.first() || message.author;
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      const embed = embeds
        .base(user.tag)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: 'Account created', value: fullTimestamp(user.createdTimestamp) },
        );
      if (member?.joinedTimestamp) embed.addFields({ name: 'Joined', value: fullTimestamp(member.joinedTimestamp) });
      return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  });

  define('serverinfo', {
    aliases: ['si', 'guild'],
    description: 'Show information about this server',
    run: async (message) => {
      const g = message.guild;
      return message.reply({
        embeds: [
          embeds
            .base(g.name)
            .setThumbnail(g.iconURL({ size: 256 }) || null)
            .addFields(
              { name: 'Members', value: number(g.memberCount), inline: true },
              { name: 'Channels', value: number(g.channels.cache.size), inline: true },
              { name: 'Roles', value: number(g.roles.cache.size), inline: true },
              { name: 'Created', value: fullTimestamp(g.createdTimestamp) },
            ),
        ],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('roll', {
    aliases: ['dice', 'r'],
    description: 'Roll dice, e.g. 2d20',
    run: async (message, args) => {
      const match = (args[0] || '1d6').match(/^(\d{1,2})?d(\d{1,4})$/i);
      if (!match) return message.reply('Use `NdM`, for example `2d6`.');
      const count = Math.min(25, Number(match[1] || 1));
      const sides = Number(match[2]);
      if (sides < 2 || sides > 1000) return message.reply('Sides must be between 2 and 1000.');
      const { rolls, total } = rng.dice(count, sides);
      return message.reply({
        embeds: [
          embeds.base(
            `${count}d${sides}`,
            `**${total}**${count > 1 ? `\n${rolls.join(' + ')}` : ''}`,
          ),
        ],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('8ball', {
    aliases: ['8b'],
    description: 'Ask the magic 8-ball',
    run: async (message, args) => {
      if (!args.length) return message.reply('Ask a question.');
      const pool = [...flavor.EIGHTBALL.positive, ...flavor.EIGHTBALL.neutral, ...flavor.EIGHTBALL.negative];
      return message.reply({
        embeds: [embeds.base('🎱', `**Q:** ${truncate(args.join(' '), 200)}\n**A:** ${rng.pick(pool)}`)],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('math', {
    aliases: ['calc', 'c'],
    description: 'Evaluate an arithmetic expression',
    run: async (message, args) => {
      const result = mathexpr.evaluate(args.join(' '));
      if (!result.ok) return message.reply(`Could not calculate that: ${result.error}`);
      return message.reply({
        embeds: [embeds.base('Result', `\`${truncate(args.join(' '), 200)}\` = **${mathexpr.format(result.value)}**`)],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('rank', {
    aliases: ['level', 'lvl'],
    description: 'Show your level',
    run: async (message) => {
      if (!bot.db.settings(message.guildId).leveling.enabled) return message.reply('Levelling is off on this server.');
      const user = message.mentions.users.first() || message.author;
      const record = bot.db.member(message.guildId, user.id);
      const leveling = bot.features.leveling;
      const p = leveling.progress(record.xp);
      const rank = leveling.rankOf(message.guildId, user.id);
      return message.reply({
        embeds: [
          embeds.base(
            `${user.username} — level ${p.level}`,
            `\`${progressBar(p.ratio, 20)}\`\n${number(p.current)} / ${number(p.needed)} XP · rank #${rank || '—'}`,
          ),
        ],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('balance', {
    aliases: ['bal', 'coins'],
    description: 'Show your balance',
    run: async (message) => {
      const settings = bot.db.settings(message.guildId);
      if (!settings.economy.enabled) return message.reply('The economy is off on this server.');
      const user = message.mentions.users.first() || message.author;
      const balance = bot.features.economy.balance(message.guildId, user.id);
      const symbol = settings.economy.currency;
      return message.reply({
        embeds: [
          embeds.base(
            `${user.username}'s balance`,
            `Wallet ${symbol} **${number(balance.wallet)}**\nBank ${symbol} **${number(balance.bank)}**\nTotal ${symbol} **${number(balance.total)}**`,
          ),
        ],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('afk', {
    description: 'Mark yourself as away',
    run: async (message, args) => {
      const reason = args.join(' ') || 'Away';
      bot.features.afk.set(message.guildId, message.author.id, reason);
      return message.reply({
        embeds: [embeds.success('AFK set', `You are marked away: ${truncate(reason, 200)}`)],
        allowedMentions: { repliedUser: false },
      });
    },
  });

  define('snipe', {
    description: 'Show the last deleted message here',
    run: async (message) => {
      const embed = bot.features.snipe.render(message.channelId);
      if (!embed) return message.reply('Nothing to snipe in this channel.');
      return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    },
  });

  define('tag', {
    aliases: ['t'],
    description: 'Show a saved tag',
    run: async (message, args) => {
      if (!args[0]) {
        const all = bot.db.tags(message.guildId);
        if (!all.length) return message.reply('This server has no tags yet.');
        return message.reply({
          embeds: [embeds.base('Tags', all.map(([name]) => `\`${name}\``).join(', '))],
          allowedMentions: { repliedUser: false },
        });
      }
      const tag = bot.db.tag(message.guildId, args[0]);
      if (!tag) {
        const suggestion = closest(args[0], bot.db.tags(message.guildId).map(([n]) => n));
        return message.reply(suggestion ? `No such tag. Did you mean \`${suggestion}\`?` : 'No such tag.');
      }
      tag.uses = (tag.uses || 0) + 1;
      bot.db.setTag(message.guildId, args[0], tag);
      return message.channel.send({ content: truncate(tag.content, 2000), allowedMentions: { parse: [] } });
    },
  });

  define('uptime', {
    aliases: ['up'],
    description: 'How long the bot has been running',
    run: async (message) =>
      message.reply({
        embeds: [embeds.base('Uptime', formatDuration(bot.uptime, { parts: 3 }))],
        allowedMentions: { repliedUser: false },
      }),
  });

  // ---------- dispatcher ----------

  const api = {
    commands,

    /** Effective prefix for a guild. */
    prefixFor(guildId) {
      return bot.db.settings(guildId).prefix || bot.config.defaultPrefix;
    },

    /**
     * Message hook.
     * @returns {Promise<boolean>} whether a command ran
     */
    async onMessage(message) {
      if (!bot.config.features.prefixCommands) return false;
      if (!message.guild || message.author.bot) return false;

      if (!bot.intents.messageContent) {
        if (!warned) {
          warned = true;
          log.info('prefix commands are disabled: the MESSAGE CONTENT intent is not available');
        }
        return false;
      }

      const prefix = api.prefixFor(message.guildId);
      if (!message.content.startsWith(prefix)) return false;

      const body = message.content.slice(prefix.length).trim();
      if (!body) return false;

      const parts = body.split(/\s+/);
      const name = parts.shift().toLowerCase();
      const args = parts.map((a) => a.slice(0, MAX_ARG_LENGTH)).slice(0, 25);

      const command = commands.get(name);
      if (!command) {
        // A near miss gets a suggestion; anything else is ignored entirely, so
        // the bot does not reply to every "!" that happens to start a sentence.
        const suggestion = closest(name, [...new Set([...commands.values()])].map((c) => c.name), 2);
        if (suggestion) {
          await message.reply({
            content: `Unknown command. Did you mean \`${prefix}${suggestion}\`?`,
            allowedMentions: { repliedUser: false },
          }).catch(() => {});
        }
        return false;
      }

      // The burst guard is shared with slash commands, so someone cannot bypass
      // it by switching interface.
      if (bot.cooldowns.guard(message.author.id) > 0) return false;

      try {
        await command.run(message, args, { prefix, bot });
        bot.counters.commands++;
        bot.db.recordCommand(`${prefix}${command.name}`);
        return true;
      } catch (e) {
        log.error(`prefix command ${command.name} threw:`, e);
        await message.reply(`That failed: ${e.message}`).catch(() => {});
        return false;
      }
    },
  };

  return api;
}

module.exports = { name: 'prefix', init };
