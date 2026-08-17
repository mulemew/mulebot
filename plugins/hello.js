/**
 * hello — the full plugin contract in one file.
 *
 * Where httpserver.js is a standalone script that just runs, this one exports
 * `init(plugin)` and uses the context it is handed: a slash command, a button,
 * a gateway listener, persistent storage and a scheduled task.
 *
 * Everything registered through `plugin` is undone by /plugin unload hello.
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  // Optional metadata, shown by /plugin list and /plugin info.
  version: '1.0.0',
  description: 'Demonstrates commands, buttons, storage and scheduled tasks',
  author: 'bundled example',

  /**
   * Called once when the plugin loads.
   * @param {import('../src/core/plugins').PluginContext} plugin
   */
  init(plugin) {
    const { bot, log, store } = plugin;

    // ---------- a slash command ----------
    plugin.registerCommand({
      data: new SlashCommandBuilder()
        .setName('hello')
        .setDescription('A greeting from the example plugin')
        .addStringOption((o) => o.setName('name').setDescription('Who to greet')),
      category: 'plugin',
      cooldown: 3,

      async execute(ctx) {
        // Counts persist across restarts in data/plugins/hello.json.
        const total = store.add('greetings', 1);
        const mine = store.add(`perUser.${ctx.user.id}`, 1);

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Hello from a plugin')
          .setDescription(
            [
              `Hello, **${ctx.str('name') || ctx.user.username}**.`,
              '',
              `This command was added at runtime by \`plugins/hello.js\`.`,
              `Greetings served: **${total}** overall, **${mine}** to you.`,
            ].join('\n'),
          )
          .setFooter({ text: 'Unload the plugin and this command disappears' });

        return ctx.send({
          embeds: [embed],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, custom_id: 'helloplugin:wave', label: 'Wave back', emoji: { name: '👋' } },
              ],
            },
          ],
        });
      },
    });

    // ---------- a button ----------
    // The namespace is the part before the first colon in the custom id.
    plugin.registerComponent('helloplugin', async (interaction, parts) => {
      if (parts[0] !== 'wave') return;
      const waves = store.add('waves', 1);
      await interaction.reply({
        content: `👋 back at you. That is wave number ${waves}.`,
        flags: MessageFlags.Ephemeral,
      });
    });

    // ---------- a gateway listener ----------
    // Registered through plugin.on so it is detached on unload; a bare
    // bot.client.on() would keep firing after the plugin was gone.
    plugin.onDiscord('guildCreate', (guild) => {
      log.info(`the bot joined ${guild.name} (${guild.memberCount} members)`);
      store.add('guildsJoinedSinceLoad', 1);
    });

    // ---------- a persistent scheduled task ----------
    // Task types are handled by name. Anything queued while the plugin is
    // unloaded is parked, not lost, and runs when it is loaded again.
    plugin.registerTask('hello_ping', async (task) => {
      const user = await bot.client.users.fetch(task.data.userId).catch(() => null);
      await user?.send('👋 A scheduled hello from the example plugin.').catch(() => {});
    });

    // ---------- a tracked timer ----------
    // setInterval is shadowed inside a plugin, so this is cleared on unload
    // without any bookkeeping here.
    plugin.setInterval(
      () => {
        log.debug(`still here — ${store.get('greetings', 0)} greeting(s) served`);
      },
      6 * 60 * 60 * 1000,
    );

    plugin.onReady((client) => {
      log.info(`gateway is up as ${client.user.tag}, plugin is live`);
    });

    log.info('ready — try /hello');
  },

  /**
   * Optional. Runs before the automatic teardown, while the plugin's resources
   * still exist. Use it for anything the host cannot know about, such as
   * flushing a buffer or saying goodbye to an external service.
   */
  async unload(plugin) {
    plugin.store.set('lastUnloadAt', Date.now());
    plugin.log.info('goodbye');
  },
};
