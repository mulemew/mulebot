'use strict';

const { SlashCommandBuilder, MessageFlags, version: djsVersion } = require('discord.js');
const embeds = require('../../util/embeds');
const components = require('../../util/components');
const perms = require('../../util/perms');
const { formatDuration, fullTimestamp } = require('../../util/time');
const { number, truncate, table, codeBlock } = require('../../util/text');
const { LEVELS, buffer: logBuffer } = require('../../core/logger');

/**
 * Core commands: /ping, /help, /botinfo, /stats.
 *
 * /help is the one command every server uses and the one most bots get wrong.
 * This version is built around a category select menu rather than a single wall
 * of text, because the command list is long enough that a single embed would
 * exceed Discord's field limits and be unreadable anyway.
 */

const CATEGORY_META = {
  utility: { emoji: '🔧', label: 'Utility', blurb: 'Information, tools and everyday helpers' },
  fun: { emoji: '🎲', label: 'Fun', blurb: 'Dice, randomness and small distractions' },
  games: { emoji: '🎮', label: 'Games', blurb: 'Interactive games with buttons' },
  economy: { emoji: '🪙', label: 'Economy', blurb: 'Currency, shop and earning commands' },
  levels: { emoji: '📈', label: 'Levels', blurb: 'XP, ranks and leaderboards' },
  moderation: { emoji: '🛡️', label: 'Moderation', blurb: 'Punishments, purging and records' },
  config: { emoji: '⚙️', label: 'Configuration', blurb: 'Server setup, requires Manage Server' },
  social: { emoji: '💬', label: 'Social', blurb: 'Profiles and member interaction' },
  owner: { emoji: '🔑', label: 'Owner', blurb: 'Bot operator tooling' },
  misc: { emoji: '📦', label: 'Other', blurb: 'Everything else' },
};

/** Renders the overview page listing every category. */
function overviewEmbed(bot, guildId) {
  const byCategory = bot.registry.byCategory();
  const lines = [];

  for (const [category, list] of [...byCategory.entries()].sort()) {
    const meta = CATEGORY_META[category] || CATEGORY_META.misc;
    lines.push(`${meta.emoji} **${meta.label}** — ${list.length} command(s)\n   ${meta.blurb}`);
  }

  const settings = guildId ? bot.db.settings(guildId) : null;
  const enabled = settings
    ? Object.entries({
        leveling: settings.leveling.enabled,
        economy: settings.economy.enabled,
        automod: settings.automod.enabled,
        logging: settings.logging.enabled,
        starboard: settings.starboard.enabled,
        tickets: settings.tickets.enabled,
      })
        .filter(([, on]) => on)
        .map(([name]) => name)
    : [];

  return embeds
    .base(
      'Command list',
      [
        `I have **${bot.registry.size}** commands. Pick a category below to see them.`,
        '',
        lines.join('\n'),
      ].join('\n'),
    )
    .addFields({
      name: 'Enabled on this server',
      value: enabled.length ? enabled.join(', ') : 'Nothing yet — an admin can run `/config` to switch features on.',
    })
    .setFooter({ text: `discord.js v${djsVersion} · use /help command:<name> for details` });
}

/** Renders one category page. */
function categoryEmbed(bot, category) {
  const meta = CATEGORY_META[category] || CATEGORY_META.misc;
  const list = bot.registry.byCategory().get(category) || [];

  const lines = list.map((command) => {
    const options = command.data.options || [];
    const hasSubs = options.some((o) => o.toJSON?.().type === 1 || o.type === 1 || o.type === 2);
    const signature = hasSubs ? `/${command.data.name} <subcommand>` : `/${command.data.name}`;
    return `\`${signature}\`\n   ${command.data.description}`;
  });

  return embeds
    .base(`${meta.emoji} ${meta.label}`, `${meta.blurb}\n\n${lines.join('\n') || 'Nothing here.'}`)
    .setFooter({ text: `${list.length} command(s)` });
}

/** Detailed page for a single command. */
function commandEmbed(command) {
  const json = command.data.toJSON();
  const embed = embeds.base(`/${json.name}`, json.description);

  const subs = (json.options || []).filter((o) => o.type === 1 || o.type === 2);
  const args = (json.options || []).filter((o) => o.type !== 1 && o.type !== 2);

  if (subs.length) {
    embed.addFields({
      name: 'Subcommands',
      value: truncate(
        subs
          .map((s) =>
            s.type === 2
              ? `**${s.name}** (group)\n${(s.options || []).map((x) => `  · \`${x.name}\` — ${x.description}`).join('\n')}`
              : `\`${s.name}\` — ${s.description}`,
          )
          .join('\n'),
        1024,
      ),
    });
  }

  if (args.length) {
    embed.addFields({
      name: 'Options',
      value: truncate(
        args.map((o) => `\`${o.name}\`${o.required ? '' : ' (optional)'} — ${o.description}`).join('\n'),
        1024,
      ),
    });
  }

  const notes = [];
  if (command.cooldown) notes.push(`Cooldown: ${command.cooldown}s`);
  if (command.feature) notes.push(`Requires the **${command.feature}** feature`);
  if (command.userPerms?.length) notes.push('Requires elevated permissions');
  if (command.guildOnly) notes.push('Server only');
  if (notes.length) embed.addFields({ name: 'Notes', value: notes.join(' · ') });

  if (command.examples?.length) {
    embed.addFields({ name: 'Examples', value: command.examples.map((e) => `\`${e}\``).join('\n') });
  }

  return embed;
}

const help = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the command list, or details about one command')
    .addStringOption((o) =>
      o.setName('command').setDescription('Show detailed help for one command').setAutocomplete(true),
    )
    .addBooleanOption((o) => o.setName('private').setDescription('Only show the reply to you')),
  category: 'utility',
  cooldown: 3,
  guildOnly: false,
  examples: ['/help', '/help command:ban'],

  /** Registers the category select menu route. */
  setup(bot) {
    bot.components.register('help', async (interaction, parts) => {
      const value = interaction.values?.[0] || parts[0];
      const embed = value === 'overview' ? overviewEmbed(bot, interaction.guildId) : categoryEmbed(bot, value);
      await interaction.update({ embeds: [embed], components: [help.buildMenu(bot, value)] });
    });
  },

  buildMenu(bot, selected = 'overview') {
    const categories = [...bot.registry.byCategory().keys()].sort();
    return components.select({
      id: components.customId('help', 'pick'),
      placeholder: 'Choose a category',
      options: [
        { label: 'Overview', value: 'overview', emoji: '🏠', default: selected === 'overview' },
        ...categories.map((c) => {
          const meta = CATEGORY_META[c] || CATEGORY_META.misc;
          return {
            label: meta.label,
            value: c,
            emoji: meta.emoji,
            description: truncate(meta.blurb, 100),
            default: selected === c,
          };
        }),
      ],
    });
  },

  async autocomplete(ctx) {
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = ctx.bot.registry
      .all()
      .filter((c) => !c.hidden && c.data.name.includes(focused))
      .slice(0, 25)
      .map((c) => ({ name: `/${c.data.name} — ${truncate(c.data.description, 60)}`, value: c.data.name }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const wanted = ctx.str('command');
    const ephemeral = ctx.bool('private', false);

    if (wanted) {
      const command = ctx.bot.registry.get(wanted.toLowerCase().replace(/^\//, ''));
      if (!command) return ctx.fail(`There is no command called \`${wanted}\`. Try \`/help\` with no options.`);
      return ephemeral
        ? ctx.whisper({ embeds: [commandEmbed(command)] })
        : ctx.send({ embeds: [commandEmbed(command)] });
    }

    const payload = {
      embeds: [overviewEmbed(ctx.bot, ctx.i.guildId)],
      components: [help.buildMenu(ctx.bot)],
    };
    if (ephemeral) payload.flags = MessageFlags.Ephemeral;
    return ctx.send(payload);
  },
};

const ping = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency'),
  category: 'utility',
  cooldown: 5,
  guildOnly: false,

  async execute(ctx) {
    const sent = await ctx.i.reply({ content: 'Measuring…', withResponse: true });
    const rtt = sent.resource.message.createdTimestamp - ctx.i.createdTimestamp;
    const ws = Math.round(ctx.client.ws.ping);

    // Round trip includes Discord's own processing, so it is always larger than
    // the gateway heartbeat. Labelling both avoids the usual "why is ping 400ms"
    // confusion.
    const verdict = rtt < 300 ? 'Healthy' : rtt < 800 ? 'A little slow' : 'Sluggish — check the host';

    await ctx.i.editReply({
      content: null,
      embeds: [
        embeds.base('Pong', [
          `**Round trip:** ${rtt}ms — the time for this reply to make it back`,
          `**WebSocket:** ${ws < 0 ? 'measuring…' : `${ws}ms`} — the gateway heartbeat`,
          '',
          verdict,
        ].join('\n')),
      ],
    });
  },
};

const botinfo = {
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Show information about the bot'),
  category: 'utility',
  cooldown: 10,
  guildOnly: false,

  async execute(ctx) {
    const s = ctx.bot.snapshot();
    const user = ctx.client.user;

    const embed = embeds
      .base(user.tag, 'A modular Discord bot: moderation, levelling, economy, games and server automation.')
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'Servers', value: number(s.guilds), inline: true },
        { name: 'Members', value: number(s.users), inline: true },
        { name: 'Commands', value: number(s.registry.commands), inline: true },
        { name: 'Uptime', value: formatDuration(s.uptimeMs, { parts: 3 }), inline: true },
        { name: 'Memory', value: `${s.memoryMb} MB`, inline: true },
        { name: 'Latency', value: `${s.ping}ms`, inline: true },
        { name: 'Node', value: s.node, inline: true },
        { name: 'discord.js', value: `v${s.djs}`, inline: true },
        { name: 'Created', value: fullTimestamp(user.createdTimestamp), inline: true },
        {
          name: 'Privileged intents',
          value: [
            `Server members: ${s.intents.members ? '✅ on' : '❌ off — welcome messages and autorole are disabled'}`,
            `Message content: ${s.intents.messageContent ? '✅ on' : '❌ off — automod, XP and prefix commands are disabled'}`,
          ].join('\n'),
        },
        { name: 'Features loaded', value: s.features.join(', ') },
      );

    // Derived from the permissions the commands actually require, so it
    // cannot drift from them again.
    const invite = perms.inviteUrl(user.id);
    return ctx.send({
      embeds: [embed],
      components: [components.linkRow([{ label: 'Invite me', url: invite, emoji: '➕' }])],
    });
  },
};

const stats = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Detailed runtime statistics')
    .addStringOption((o) =>
      o
        .setName('section')
        .setDescription('Which section to show')
        .addChoices(
          { name: 'overview', value: 'overview' },
          { name: 'commands', value: 'commands' },
          { name: 'storage', value: 'storage' },
          { name: 'scheduler', value: 'scheduler' },
          { name: 'games', value: 'games' },
          { name: 'memory', value: 'memory' },
          { name: 'logs', value: 'logs' },
        ),
    ),
  category: 'utility',
  cooldown: 10,
  guildOnly: false,

  async execute(ctx) {
    const s = ctx.bot.snapshot();
    const section = ctx.str('section', 'overview');

    if (section === 'commands') {
      const rows = s.registry.top.map((c) => [`/${c.name}`, number(c.uses)]);
      return ctx.send({
        embeds: [
          embeds
            .base('Command usage', codeBlock(table(['command', 'uses'], rows, { align: [null, 'right'] })))
            .addFields(
              { name: 'Registered', value: number(s.registry.commands), inline: true },
              { name: 'Categories', value: number(s.registry.categories), inline: true },
              { name: 'Failed to load', value: number(s.registry.failures), inline: true },
            ),
        ],
      });
    }

    if (section === 'storage') {
      const rows = s.storage.map((store) => [
        store.name,
        number(store.entries),
        `${Math.round(store.bytes / 1024)}kb`,
        number(store.writes),
        store.dirty ? 'yes' : 'no',
      ]);
      return ctx.send({
        embeds: [
          embeds.base(
            'Storage',
            codeBlock(table(['store', 'entries', 'size', 'writes', 'dirty'], rows, { align: [null, 'right', 'right', 'right'] })),
          ),
        ],
      });
    }

    if (section === 'scheduler') {
      const sched = s.scheduler;
      const rows = Object.entries(sched.byType).map(([type, count]) => [type, number(count)]);
      return ctx.send({
        embeds: [
          embeds
            .base('Scheduler', rows.length ? codeBlock(table(['task type', 'pending'], rows, { align: [null, 'right'] })) : 'No pending tasks.')
            .addFields(
              { name: 'Pending', value: number(sched.pending), inline: true },
              { name: 'Executed', value: number(sched.ran), inline: true },
              { name: 'Failed', value: number(sched.failed), inline: true },
              { name: 'Next due', value: sched.next ? fullTimestamp(sched.next) : 'nothing queued' },
            ),
        ],
      });
    }

    if (section === 'games') {
      const games = ctx.bot.features.games?.snapshot?.() || { active: 0, byGame: {}, games: [] };
      return ctx.send({
        embeds: [
          embeds
            .base('Games', games.games.length ? `Loaded: ${games.games.join(', ')}` : 'Games are disabled.')
            .addFields(
              { name: 'Active sessions', value: number(games.active), inline: true },
              { name: 'Started', value: number(games.started || 0), inline: true },
              { name: 'Finished', value: number(games.finished || 0), inline: true },
            ),
        ],
      });
    }

    if (section === 'memory') {
      const maintenance = ctx.bot.features.maintenance;
      const m = maintenance?.memory() || {};
      const caches = m.caches || {};
      const budget = m.limitMb ? `${m.rssMb} MB of ${m.limitMb} MB (${m.percentOfLimit}%)` : `${m.rssMb} MB`;

      const embed = embeds
        .base('Memory', `Cache profile: **${m.profile}**`)
        .addFields(
          { name: 'Resident', value: budget, inline: true },
          { name: 'Heap used', value: `${m.heapUsedMb} MB of ${m.heapTotalMb} MB`, inline: true },
          { name: 'External', value: `${m.externalMb} MB`, inline: true },
          {
            name: 'discord.js caches',
            value: [
              `Messages: ${number(caches.messages || 0)}`,
              `Members: ${number(caches.members || 0)}`,
              `Users: ${number(caches.users || 0)}`,
              `Channels: ${number(caches.channels || 0)}`,
              `Roles: ${number(caches.roles || 0)}`,
              `Voice states: ${number(caches.voiceStates || 0)}`,
            ].join('\n'),
            inline: true,
          },
          {
            name: 'Stored records',
            value: s.storage.map((store) => `${store.name}: ${number(store.entries)}`).join('\n'),
            inline: true,
          },
        );

      if (maintenance?.lastResult) {
        const r = maintenance.lastResult;
        embed.addFields({
          name: 'Last housekeeping pass',
          value:
            `${fullTimestamp(maintenance.lastRun)}\n` +
            `Pruned ${number(r.total)} record(s) in ${r.took}ms` +
            (r.total
              ? `\n${Object.entries(r)
                  .filter(([k, v]) => v && !['took', 'total'].includes(k))
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')}`
              : ''),
        });
      } else {
        embed.addFields({ name: 'Last housekeeping pass', value: 'Has not run yet — first pass is an hour after boot.' });
      }

      if (s.logFile) {
        embed.addFields({
          name: 'Log file',
          value: `${s.logFile.file}\n${Math.round(s.logFile.bytes / 1024)}kb, rotates at ${Math.round(s.logFile.maxBytes / 1024)}kb, keeps ${s.logFile.keep}`,
        });
      }

      return ctx.send({ embeds: [embed] });
    }

    if (section === 'logs') {
      if (!ctx.bot.isOwner(ctx.user.id)) return ctx.fail('Recent log output is restricted to the bot owner.');
      const lines = logBuffer
        .tail(25, LEVELS.info)
        .map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`);
      return ctx.whisper({
        embeds: [embeds.base('Recent log lines', codeBlock(truncate(lines.join('\n') || 'nothing buffered', 3800)))],
      });
    }

    return ctx.send({
      embeds: [
        embeds
          .base('Runtime statistics')
          .addFields(
            { name: 'Uptime', value: formatDuration(s.uptimeMs, { parts: 3 }), inline: true },
            { name: 'Ready since', value: s.readyAt ? fullTimestamp(s.readyAt) : 'not ready', inline: true },
            { name: 'Latency', value: `${s.ping}ms`, inline: true },
            { name: 'Servers', value: number(s.guilds), inline: true },
            { name: 'Members', value: number(s.users), inline: true },
            { name: 'Channels', value: number(s.channels), inline: true },
            { name: 'RSS memory', value: `${s.memoryMb} MB`, inline: true },
            { name: 'Heap used', value: `${s.heapMb} MB`, inline: true },
            { name: 'Log buffer', value: `${s.logLines} lines`, inline: true },
            {
              name: 'Counters',
              value: [
                `Commands run: ${number(s.counters.commands)}`,
                `Interactions seen: ${number(s.counters.interactions)}`,
                `Messages seen: ${number(s.counters.messages)}`,
                `Errors: ${number(s.counters.errors)}`,
              ].join('\n'),
            },
            {
              name: 'Subsystems',
              value: [
                `Pending tasks: ${s.scheduler.pending}`,
                `Active cooldowns: ${s.cooldowns.cooldowns}`,
                `Open paginators: ${s.paginator.sessions}`,
              ].join('\n'),
            },
          ),
      ],
    });
  },
};

module.exports = [ping, help, botinfo, stats];
