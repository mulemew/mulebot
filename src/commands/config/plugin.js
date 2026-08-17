'use strict';

const { SlashCommandBuilder } = require('discord.js');
const path = require('node:path');
const embeds = require('../../util/embeds');
const { paginate } = require('../../util/pager');
const { truncate, number, humanList, codeBlock } = require('../../util/text');
const { relative, fullTimestamp } = require('../../util/time');

/**
 * /plugin — manage the plugins directory at runtime.
 *
 * Owner-only, and not because loading a plugin is a delicate operation: a
 * plugin runs with this process's full privileges, so being able to load one
 * from chat is equivalent to being able to run code on the host. Server admins
 * get no access to this, only the bot operator.
 */

const STATE_ICONS = {
  loaded: '🟢',
  failed: '🔴',
  disabled: '⚪',
  pending: '🟡',
};

const plugin = {
  data: new SlashCommandBuilder()
    .setName('plugin')
    .setDescription('Manage plugins (bot owner only)')
    .addSubcommand((s) => s.setName('list').setDescription('Show every plugin and its state'))
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Details about one plugin')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('load')
        .setDescription('Load a plugin that is not currently running')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('unload')
        .setDescription('Unload a plugin and release everything it holds')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reload')
        .setDescription('Reload a plugin, picking up edits to its file')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('scan').setDescription('Look for newly added plugin files and load them'))
    .addSubcommand((s) =>
      s
        .setName('watch')
        .setDescription('Auto-reload plugins when their files change')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    ),
  category: 'owner',
  ownerOnly: true,
  hidden: true,
  guildOnly: false,
  cooldown: 0,

  async autocomplete(ctx) {
    const host = ctx.bot.plugins;
    if (!host) return ctx.i.respond([]);
    const focused = ctx.i.options.getFocused().toLowerCase();
    const matches = host
      .list()
      .filter((p) => p.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((p) => ({ name: `${p.name} (${p.state})`, value: p.name }));
    await ctx.i.respond(matches);
  },

  async execute(ctx) {
    const host = ctx.bot.plugins;
    if (!host) return ctx.fail('The plugin host is not initialised.');
    if (!ctx.bot.config.pluginsEnabled && ctx.sub !== 'list') {
      return ctx.fail('Plugins are disabled by `PLUGINS_ENABLED=false`. Restart with it unset to use them.');
    }

    const name = ctx.str('name');

    switch (ctx.sub) {
      case 'list': {
        const all = host.list();
        const stats = host.stats();

        if (!all.length) {
          return ctx.whisper({
            embeds: [
              embeds.base(
                'No plugins',
                [
                  `Drop a \`.js\` file into \`${path.relative(ctx.bot.config.rootDir, host.dir) || 'plugins'}/\` and run \`/plugin scan\`.`,
                  '',
                  'A plugin can be a plain standalone script — it just runs — or export `init(plugin)` for access to the bot.',
                  'See `plugins/README.md` for the full contract.',
                ].join('\n'),
              ),
            ],
          });
        }

        const pages = paginate(all, 8, (slice, { page, total }) => {
          const embed = embeds
            .base(
              'Plugins',
              `${stats.loaded} loaded · ${stats.failed} failed · ${stats.disabled} disabled` +
                (stats.watching ? ' · 👀 watching for changes' : ''),
            )
            .setFooter({ text: `Page ${page}/${total} · ${host.dir}` });

          for (const p of slice) {
            const bits = [];
            if (p.description) bits.push(p.description);
            if (p.error) bits.push(`⚠️ ${truncate(p.error, 200)}`);
            if (p.owned?.commands.length) bits.push(`commands: ${p.owned.commands.map((c) => `/${c}`).join(' ')}`);
            if (p.owned && (p.owned.timers || p.owned.resources || p.owned.listeners)) {
              bits.push(
                `holds ${humanList(
                  [
                    p.owned.timers ? `${p.owned.timers} timer(s)` : null,
                    p.owned.resources ? `${p.owned.resources} resource(s)` : null,
                    p.owned.listeners ? `${p.owned.listeners} listener(s)` : null,
                  ].filter(Boolean),
                )}`,
              );
            }
            if (p.loadedAt) bits.push(`loaded ${relative(p.loadedAt)}`);

            embed.addFields({
              name: `${STATE_ICONS[p.state] || '❔'} ${p.name}${p.version ? ` v${p.version}` : ''} · ${p.kind}`,
              value: truncate(bits.join('\n') || `\`${p.file}\``, 1024),
            });
          }
          return embed;
        });

        return ctx.paginate(pages, { ephemeral: true });
      }

      case 'info': {
        const found = host.get(name);
        if (!found) return ctx.fail(`No plugin called \`${name}\`.`);

        const owned = found.context?.describe();
        const embed = embeds
          .base(
            `${STATE_ICONS[found.state] || '❔'} ${found.name}`,
            found.description || '*No description exported.*',
          )
          .addFields(
            { name: 'State', value: found.state, inline: true },
            { name: 'Kind', value: found.kind, inline: true },
            { name: 'Version', value: found.version || 'unversioned', inline: true },
            { name: 'File', value: `\`${found.file}\`` },
          );

        if (found.loadedAt) embed.addFields({ name: 'Loaded', value: fullTimestamp(found.loadedAt) });
        if (found.meta.author) embed.addFields({ name: 'Author', value: found.meta.author, inline: true });

        if (owned) {
          embed.addFields({
            name: 'Resources held',
            value: [
              `Timers: ${owned.timers}`,
              `Tracked resources: ${owned.resources}`,
              `Event listeners: ${owned.listeners}`,
              `Cleanup hooks: ${owned.cleanups}`,
              `Commands: ${owned.commands.length ? owned.commands.map((c) => `/${c}`).join(', ') : 'none'}`,
              `Component routes: ${owned.components.join(', ') || 'none'}`,
              `Task types: ${owned.tasks.join(', ') || 'none'}`,
            ].join('\n'),
          });
        }

        if (found.error) {
          embed.addFields({
            name: '⚠️ Last error',
            value: codeBlock(truncate(found.error.stack || found.error.message, 900)),
          });
          embed.setColor(embeds.theme.danger);
        }

        return ctx.whisper({ embeds: [embed] });
      }

      case 'load': {
        const known = host.get(name);
        if (known?.state === 'loaded') return ctx.fail(`\`${name}\` is already loaded.`);

        await ctx.defer({ ephemeral: true });

        // Either a known-but-unloaded plugin, or something newly dropped in.
        const entry = known
          ? { name: known.name, file: known.file, kind: known.kind === 'native' ? 'native' : 'script' }
          : host.discover().find((e) => e.name === name);

        if (!entry) return ctx.fail(`No file for \`${name}\`. Run \`/plugin scan\` after adding it.`);

        host.plugins.delete(name);
        const ok = await host.load(entry);
        await host.syncCommands();

        if (!ok) {
          const failed = host.get(name);
          return ctx.fail(`\`${name}\` failed to load:\n${codeBlock(truncate(failed?.error?.message || 'unknown', 900))}`);
        }
        const owned = host.get(name).context.describe();
        return ctx.ok(
          'Plugin loaded',
          [
            `\`${name}\` is running.`,
            owned.commands.length ? `Registered ${owned.commands.map((c) => `/${c}`).join(', ')}.` : null,
            owned.resources ? `Holding ${owned.resources} tracked resource(s).` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          { ephemeral: true },
        );
      }

      case 'unload': {
        await ctx.defer({ ephemeral: true });
        const result = await host.unload(name);
        if (!result.ok) return ctx.fail(result.error);
        await host.syncCommands();

        return ctx.ok(
          'Plugin unloaded',
          [
            `\`${name}\` has been stopped and everything it held was released.`,
            result.problems?.length
              ? `\n⚠️ ${result.problems.length} problem(s) during teardown:\n${codeBlock(truncate(result.problems.join('\n'), 800))}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          { ephemeral: true },
        );
      }

      case 'reload': {
        await ctx.defer({ ephemeral: true });
        const result = await host.reload(name);
        await host.syncCommands();

        if (!result.ok) return ctx.fail(`Reload failed:\n${codeBlock(truncate(result.error, 900))}`);
        return ctx.ok('Plugin reloaded', `\`${name}\` was restarted from its file on disk.`, { ephemeral: true });
      }

      case 'scan': {
        await ctx.defer({ ephemeral: true });
        const result = await host.loadNew();
        await host.syncCommands();

        if (!result.found) return ctx.ok('Nothing new', 'No unloaded plugin files were found.', { ephemeral: true });
        return ctx.ok(
          'Scan complete',
          `Found ${number(result.found)} new file(s), loaded ${number(result.loaded)}.` +
            (result.loaded < result.found ? '\nSee `/plugin list` for the ones that failed.' : ''),
          { ephemeral: true },
        );
      }

      case 'watch': {
        const enabled = ctx.bool('enabled');
        if (enabled) {
          const started = host.startWatching();
          return ctx.ok(
            started ? 'Watching' : 'Already watching',
            'Plugin files are reloaded automatically when they change.\n\nThis is convenient while developing and a liability in production — a half-saved file gets loaded.',
            { ephemeral: true },
          );
        }
        host.stopWatching();
        return ctx.ok('Stopped watching', 'Use `/plugin reload` to pick up changes manually.', { ephemeral: true });
      }

      default:
        return ctx.fail('Unknown subcommand.');
    }
  },
};

module.exports = plugin;
