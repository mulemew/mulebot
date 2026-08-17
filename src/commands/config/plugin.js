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
    .addSubcommand((s) =>
      s
        .setName('upload')
        .setDescription('Attach a .js file or a .zip/.tar.gz bundle and install it')
        .addAttachmentOption((o) => o.setName('file').setDescription('The plugin file or archive').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('How long it should survive')
            .addChoices(
              { name: 'keep on disk (default)', value: 'persist' },
              { name: 'memory only — gone on restart', value: 'memory' },
            ),
        )
        .addStringOption((o) => o.setName('name').setDescription('Override the plugin name')),
    )
    .addSubcommand((s) =>
      s
        .setName('install')
        .setDescription('Download and install a plugin from a URL')
        .addStringOption((o) => o.setName('url').setDescription('A .js file, or a .zip/.tar.gz bundle').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('How long it should survive')
            .addChoices(
              { name: 'keep on disk (default)', value: 'persist' },
              { name: 'run once — file deleted, gone on restart', value: 'once' },
              { name: 'memory only — refetched from the URL on restart', value: 'memory' },
            ),
        )
        .addStringOption((o) => o.setName('name').setDescription('Override the plugin name')),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Unload a plugin and delete its file')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('source')
        .setDescription('Send a plugin\'s source back to you')
        .addStringOption((o) => o.setName('name').setDescription('Plugin name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('npm')
        .setDescription('Install an npm package so plugins can require it')
        .addStringOption((o) => o.setName('package').setDescription('e.g. axios, or @scope/name@1.2.3').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remotes')
        .setDescription('Plugins remembered by URL, and refetched on every start')
        .addStringOption((o) => o.setName('forget').setDescription('Stop refetching this one on start')),
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

      case 'upload': {
        // Discord already authenticated the uploader and this command is
        // owner-only, so the attachment is as trusted as the person running it.
        // No port, no
        // token to leak, no endpoint reachable from the internet.
        const file = ctx.attachmentOpt('file');
        const mode = ctx.str('mode', 'persist');

        if (file.size > 8 * 1024 * 1024) return ctx.fail('Keep the file under 8 MB.');
        if (!/\.(js|cjs|zip|tar|gz|tgz)$/i.test(file.name)) {
          return ctx.fail('Attach a `.js` file, or a `.zip` / `.tar.gz` bundle.');
        }

        await ctx.defer({ ephemeral: true });

        const response = await fetch(file.url).catch(() => null);
        if (!response?.ok) return ctx.fail('I could not download that attachment from Discord.');
        const buffer = Buffer.from(await response.arrayBuffer());

        let result;
        try {
          result = await host.installFromBuffer(buffer, {
            filename: file.name,
            name: ctx.str('name') || undefined,
            mode,
          });
        } catch (e) {
          return ctx.fail(`Install failed:\n${codeBlock(truncate(e.message, 900))}`);
        }
        await host.syncCommands();

        if (!result.ok) return ctx.fail(`\`${result.name}\` failed to load:\n${codeBlock(truncate(result.error || 'unknown', 900))}`);

        const owned = host.get(result.name)?.context.describe();
        return ctx.ok(
          'Plugin installed',
          [
            `\`${result.name}\` is running (${result.mode || 'persist'}).`,
            result.files ? `Extracted ${result.files} file(s).` : null,
            result.stripped ? `Stripped the \`${result.stripped}/\` wrapper.` : null,
            owned?.commands.length ? `Registered ${owned.commands.map((c) => `/${c}`).join(', ')}.` : null,
            mode === 'memory' ? '\n⚠️ Memory only — it disappears on the next restart.' : null,
            result.temporary
              ? '\n⚠️ The plugins directory is read-only, so this went to a temporary one. It works ' +
                'now but is gone after a restart. Mount a volume or set `PLUGINS_DIR` to keep it.'
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          { ephemeral: true },
        );
      }

      case 'install': {
        const url = ctx.str('url');
        const mode = ctx.str('mode', 'persist');

        await ctx.defer({ ephemeral: true });

        let result;
        try {
          result = await host.installFromUrl(url, { mode, name: ctx.str('name') || undefined });
        } catch (e) {
          return ctx.fail(`Install failed:\n${codeBlock(truncate(e.message, 900))}`);
        }
        await host.syncCommands();

        if (!result.ok) return ctx.fail(`\`${result.name}\` failed to load:\n${codeBlock(truncate(result.error || 'unknown', 900))}`);

        const notes = {
          persist: 'Written to the plugins directory; it survives restarts.',
          once: 'The file was deleted after loading. It runs until the next restart, then it is gone.',
          memory: 'Never written to disk. The URL is remembered and fetched again on every start.',
        };
        const owned = host.get(result.name)?.context.describe();

        return ctx.ok(
          'Plugin installed',
          [
            `\`${result.name}\` is running.`,
            notes[result.mode || 'persist'],
            result.temporary
              ? '⚠️ The plugins directory is read-only, so this went to a temporary one. It works ' +
                'now but is gone after a restart. Mount a volume or set `PLUGINS_DIR` to keep it.'
              : null,
            result.files ? `Extracted ${result.files} file(s).` : null,
            owned?.commands.length ? `Registered ${owned.commands.map((c) => `/${c}`).join(', ')}.` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          { ephemeral: true },
        );
      }

      case 'delete': {
        const known = host.get(name);
        if (!known) return ctx.fail(`No plugin called \`${name}\`.`);
        if (known.kind === 'memory') {
          // Nothing on disk to remove; forgetting the URL is the equivalent.
          await host.unload(name);
          host.forgetRemote(name);
          host.plugins.delete(name);
          await host.syncCommands();
          return ctx.ok('Removed', `\`${name}\` was unloaded and its source URL forgotten.`, { ephemeral: true });
        }

        await ctx.defer({ ephemeral: true });
        if (known.state === 'loaded') await host.unload(name);

        const fs = require('node:fs');
        const target = known.file;
        // A directory plugin's whole folder goes, a single file just the file.
        const dir = path.dirname(target);
        const insidePluginDir = path.resolve(dir) !== path.resolve(host.dir);

        try {
          if (insidePluginDir) fs.rmSync(dir, { recursive: true, force: true });
          else fs.rmSync(target, { force: true });
        } catch (e) {
          return ctx.fail(`Could not delete it: ${e.message}`);
        }

        host.plugins.delete(name);
        host.forgetRemote(name);
        await host.syncCommands();

        return ctx.ok(
          'Deleted',
          `\`${name}\` was unloaded and ${insidePluginDir ? 'its directory' : 'its file'} removed.`,
          { ephemeral: true },
        );
      }

      case 'source': {
        const known = host.get(name);
        if (!known) return ctx.fail(`No plugin called \`${name}\`.`);
        if (known.kind === 'memory') {
          return ctx.fail('That plugin runs from memory, so there is no file to send. Its source is at its origin URL.');
        }

        const fs = require('node:fs');
        if (!fs.existsSync(known.file)) return ctx.fail('Its file no longer exists on disk.');

        const content = fs.readFileSync(known.file, 'utf8');
        const { AttachmentBuilder } = require('discord.js');
        return ctx.whisper({
          embeds: [
            embeds.base(
              `${name} source`,
              `\`${known.file}\`\n${number(Buffer.byteLength(content))} bytes`,
            ),
          ],
          files: [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: path.basename(known.file) })],
        });
      }

      case 'npm': {
        const spec = ctx.str('package');
        await ctx.defer({ ephemeral: true });

        const result = await host.installNpmPackage(spec);
        if (!result.ok) {
          return ctx.fail(
            `\`npm install ${spec}\` failed (exit ${result.code}):\n${codeBlock(truncate(result.output || 'no output', 800))}`,
          );
        }
        return ctx.ok(
          'Package installed',
          [
            `\`${spec}\` is now available to every plugin via \`require()\`.`,
            '',
            codeBlock(truncate(result.output.split('\n').slice(-6).join('\n'), 600)),
          ].join('\n'),
          { ephemeral: true },
        );
      }

      case 'remotes': {
        const forget = ctx.str('forget');
        if (forget) {
          if (!host.forgetRemote(forget)) return ctx.fail(`\`${forget}\` is not in the remembered list.`);
          return ctx.ok(
            'Forgotten',
            `\`${forget}\` will not be fetched again on start. If it is running now, it stays until the next restart.`,
            { ephemeral: true },
          );
        }

        const remotes = host.readRemotes();
        const entries = Object.entries(remotes);
        if (!entries.length) {
          return ctx.whisper(
            'Nothing is remembered by URL. `/plugin install` with mode `memory` records its source here so it can ' +
              'be fetched again on every start.',
          );
        }

        return ctx.whisper({
          embeds: [
            embeds
              .base(
                'Remembered sources',
                entries
                  .map(([n, r]) => {
                    const state = host.get(n)?.state || 'not loaded';
                    return `**${n}** — \`${r.mode}\` · ${state}\n${truncate(r.url, 90)}\n*added ${relative(r.at)}*`;
                  })
                  .join('\n\n'),
              )
              .setFooter({ text: 'Only "memory" plugins are refetched; the rest are on disk already.' }),
          ],
        });
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
