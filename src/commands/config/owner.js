'use strict';

const { SlashCommandBuilder } = require('discord.js');
const embeds = require('../../util/embeds');
const { LEVELS } = require('../../core/logger');
const { paginate } = require('../../util/pager');
const { number, truncate, codeBlock, table } = require('../../util/text');
const { formatDuration, fullTimestamp } = require('../../util/time');

/**
 * /owner — bot operator tooling.
 *
 * Restricted to the ids in OWNER_IDS, and hidden from /help. There is
 * deliberately no eval subcommand: an owner-only eval is still one leaked token
 * or one social-engineered owner away from arbitrary code execution on the
 * host, and everything it would realistically be used for is covered below.
 */

const owner = {
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription('Bot operator tools')
    .addSubcommand((s) => s.setName('status').setDescription('Full runtime diagnostics'))
    .addSubcommand((s) => s.setName('guilds').setDescription('Every server the bot is in'))
    .addSubcommand((s) =>
      s
        .setName('leave')
        .setDescription('Leave a server')
        .addStringOption((o) => o.setName('guild_id').setDescription('Server id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('blacklist')
        .setDescription('Block a user from the bot everywhere')
        .addStringOption((o) => o.setName('user_id').setDescription('User id').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why'))
        .addBooleanOption((o) => o.setName('remove').setDescription('Unblock instead')),
    )
    .addSubcommand((s) =>
      s
        .setName('loglevel')
        .setDescription('Change the log verbosity at runtime')
        .addStringOption((o) =>
          o
            .setName('level')
            .setDescription('New level')
            .setRequired(true)
            .addChoices(
              ...Object.keys(LEVELS).map((l) => ({ name: l, value: l })),
            ),
        ),
    )
    .addSubcommand((s) => s.setName('save').setDescription('Force an immediate flush of every data store'))
    .addSubcommand((s) => s.setName('backup').setDescription('Rotate a fresh backup of every data store'))
    .addSubcommand((s) =>
      s
        .setName('tasks')
        .setDescription('Inspect the scheduler queue')
        .addStringOption((o) => o.setName('type').setDescription('Filter by task type')),
    )
    .addSubcommand((s) =>
      s
        .setName('announce')
        .setDescription('Send a message to every server')
        .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true))
        .addBooleanOption((o) => o.setName('confirm').setDescription('Actually send it — otherwise this is a dry run')),
    ),
  category: 'owner',
  ownerOnly: true,
  hidden: true,
  guildOnly: false,
  cooldown: 0,

  async execute(ctx) {
    const bot = ctx.bot;

    switch (ctx.sub) {
      case 'status': {
        const s = bot.snapshot();
        const failures = bot.registry.failures;

        return ctx.whisper({
          embeds: [
            embeds
              .base('Operator status')
              .addFields(
                {
                  name: 'Process',
                  value: [
                    `Uptime: ${formatDuration(s.uptimeMs, { parts: 3 })}`,
                    `Node ${s.node} · discord.js v${s.djs}`,
                    `RSS ${s.memoryMb}MB · heap ${s.heapMb}MB`,
                    // Anything approaching 3000ms is the reason commands
                    // intermittently answer with "This interaction failed".
                    `Worst stall: ${s.lagPeakMs}ms${s.lagPeakMs >= 1000 ? ' ⚠️' : ''}`,
                    `PID ${process.pid} on ${process.platform}`,
                  ].join('\n'),
                },
                {
                  name: 'Gateway',
                  value: [
                    `Ping ${s.ping}ms`,
                    `${s.guilds} guild(s), ${number(s.users)} member(s)`,
                    `Intents — members: ${s.intents.members}, content: ${s.intents.messageContent}`,
                  ].join('\n'),
                },
                {
                  name: 'Counters',
                  value: Object.entries(s.counters)
                    .map(([k, v]) => `${k}: ${number(v)}`)
                    .join('\n'),
                },
                {
                  name: 'Storage',
                  value: codeBlock(
                    table(
                      ['store', 'rows', 'kb', 'dirty'],
                      s.storage.map((x) => [x.name, number(x.entries), Math.round(x.bytes / 1024), x.dirty ? 'Y' : 'N']),
                      { align: [null, 'right', 'right'] },
                    ),
                  ),
                },
                {
                  name: 'Load failures',
                  value: failures.length
                    ? truncate(failures.map((f) => `${f.file}: ${f.error}`).join('\n'), 1024)
                    : 'none',
                },
              ),
          ],
        });
      }

      case 'guilds': {
        const list = [...bot.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
        const pages = paginate(list, 10, (slice, { page, total }) =>
          embeds
            .base(
              `Servers (${list.length})`,
              slice
                .map(
                  (g) =>
                    `**${truncate(g.name, 40)}** — ${number(g.memberCount)} members\n\`${g.id}\` · owner \`${g.ownerId}\``,
                )
                .join('\n'),
            )
            .setFooter({ text: `Page ${page}/${total}` }),
        );
        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'leave': {
        const guild = bot.client.guilds.cache.get(ctx.str('guild_id').trim());
        if (!guild) return ctx.fail('I am not in a server with that id.');
        const name = guild.name;
        await guild.leave();
        return ctx.ok('Left', `Left **${name}**. Its settings are kept in case of a re-invite.`, { ephemeral: true });
      }

      case 'blacklist': {
        const userId = ctx.str('user_id').trim();
        if (!/^\d{17,20}$/.test(userId)) return ctx.fail('That is not a valid user id.');

        if (ctx.bool('remove')) {
          if (!bot.db.unblacklist(userId)) return ctx.fail('That user was not blacklisted.');
          return ctx.ok('Unblocked', `<@${userId}> can use the bot again.`, { ephemeral: true });
        }

        if (bot.isOwner(userId)) return ctx.fail('You cannot blacklist a bot owner.');
        bot.db.blacklist(userId, ctx.str('reason', 'No reason given'), ctx.user.tag);
        return ctx.ok('Blocked', `<@${userId}> can no longer use any command.`, { ephemeral: true });
      }

      case 'loglevel': {
        const level = ctx.str('level');
        const before = bot.log.level;
        bot.log.setLevel(level);
        // Child loggers were created with a copy of the threshold, so they are
        // updated too - otherwise only the root logger would change.
        for (const feature of Object.values(bot.features)) {
          if (feature?.log?.setLevel) feature.log.setLevel(level);
        }
        return ctx.ok('Log level changed', `**${before}** → **${level}**`, { ephemeral: true });
      }

      case 'save': {
        const written = bot.db.flushAll(true);
        return ctx.ok('Flushed', `Wrote ${written} store(s) to disk.`, { ephemeral: true });
      }

      case 'backup': {
        bot.db.backupAll();
        return ctx.ok(
          'Backed up',
          `Rotated backups for every store in \`${bot.config.dataDir}\`. Keeping ${bot.config.backupCount} generation(s).`,
          { ephemeral: true },
        );
      }

      case 'tasks': {
        const type = ctx.str('type');
        const tasks = bot.scheduler.find(type ? { type } : {});
        if (!tasks.length) return ctx.whisper('The scheduler queue is empty.');

        const pages = paginate(tasks.slice(0, 100), 10, (slice, { page, total }) =>
          embeds
            .base(
              `Scheduled tasks (${tasks.length})`,
              slice
                .map(
                  (t) =>
                    `**#${t.id}** \`${t.type}\`${t.parked ? ' ⛔ parked' : ''}\n` +
                    `due ${fullTimestamp(t.runAt)}${t.repeatMs ? ` · repeats every ${formatDuration(t.repeatMs)}` : ''}` +
                    `${t.error ? `\n⚠️ ${t.error}` : ''}`,
                )
                .join('\n\n'),
            )
            .setFooter({ text: `Page ${page}/${total}` }),
        );
        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'announce': {
        const message = ctx.str('message');
        const confirm = ctx.bool('confirm');
        const guilds = [...bot.client.guilds.cache.values()];

        if (!confirm) {
          // A dry run by default: an announcement to every server is not
          // something to fire off by accident.
          return ctx.whisper({
            embeds: [
              embeds
                .warning(
                  'Dry run',
                  `This would post to **${guilds.length}** server(s).\n\nRun again with \`confirm:true\` to actually send it.`,
                )
                .addFields({ name: 'Preview', value: truncate(message, 1000) }),
            ],
          });
        }

        await ctx.defer({ ephemeral: true });

        let sent = 0;
        let failed = 0;
        for (const guild of guilds) {
          const settings = bot.db.settings(guild.id);
          const channelId = settings.logging.channelId || settings.welcome.channelId;
          const channel =
            (await bot.resolveChannel(guild, channelId)) ||
            guild.channels.cache.find((c) => c.isTextBased?.() && c.permissionsFor(guild.members.me)?.has('SendMessages'));

          if (!channel) {
            failed++;
            continue;
          }
          const ok = await channel
            .send({ embeds: [embeds.base('Announcement', truncate(message, 4000))] })
            .then(() => true)
            .catch(() => false);
          ok ? sent++ : failed++;
        }

        return ctx.ok('Announcement sent', `Delivered to **${sent}** server(s), failed in **${failed}**.`, {
          ephemeral: true,
        });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

module.exports = owner;
