'use strict';

const { REST, Routes, ActivityType } = require('discord.js');

/**
 * Ready handler: command registration and presence.
 *
 * Registration happens here rather than in a separate deploy script so a fresh
 * clone works with one command, which is what the panel-hosted use case needs.
 * The trade-off is a REST call on every boot; Discord rate limits command
 * updates per day, so REGISTER_COMMANDS=false exists for rapid restart loops.
 */

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

module.exports = {
  name: 'clientReady',
  once: true,

  async execute(bot, client) {
    bot.readyAt = Date.now();
    const s = bot.snapshot();

    bot.log.banner([
      `${client.user.tag} is online`,
      `${s.guilds} server(s), ${s.channels} cached channel(s)`,
      `${bot.registry.size} command(s), ${Object.keys(bot.features).length} feature(s)` +
        (s.plugins.total ? `, ${s.plugins.loaded}/${s.plugins.total} plugin(s)` : ''),
      `intents: members=${bot.intents.members ? 'on' : 'off'} messageContent=${bot.intents.messageContent ? 'on' : 'off'}`,
      `boot took ${Date.now() - bot.startedAt}ms`,
    ]);

    // Discord knows who owns the application, so OWNER_IDS need not be set.
    await bot.resolveApplicationOwners();

    // ---------- presence ----------
    try {
      const type = ACTIVITY_TYPES[bot.config.activityType.toLowerCase()] ?? ActivityType.Playing;
      client.user.setPresence({
        activities: [{ name: bot.config.activity, type }],
        status: bot.config.status,
      });
    } catch (e) {
      bot.log.warn(`could not set presence: ${e.message}`);
    }

    // ---------- command registration ----------
    if (!bot.config.registerCommands && !bot.config.clearCommands) {
      bot.log.info('REGISTER_COMMANDS is off, leaving the existing command set alone');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(bot.config.token);
    const appId = client.user.id;
    const guildId = bot.config.guildId;

    if (bot.config.clearCommands) {
      try {
        if (guildId) await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
        else await rest.put(Routes.applicationCommands(appId), { body: [] });
        bot.log.warn(`CLEAR_COMMANDS was set: removed every ${guildId ? 'guild' : 'global'} command`);
      } catch (e) {
        bot.log.error(`failed to clear commands: ${e.message}`);
      }
      return;
    }

    // The actual PUT lives on the bot, because plugins can change the command
    // set at runtime and both paths must send an identical payload.
    await bot.registerCommands();
    if (!guildId) {
      bot.log.info('global commands can take up to an hour to appear in every client');
    }

    // ---------- first-seen bookkeeping ----------
    for (const guild of client.guilds.cache.values()) {
      const settings = bot.db.settings(guild.id);
      if (!settings.stats.joinedAt) bot.db.setSetting(guild.id, 'stats.joinedAt', Date.now());
    }
  },
};
