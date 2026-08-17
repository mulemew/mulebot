'use strict';

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { Context } = require('../core/context');
const perms = require('../util/perms');
const { relative } = require('../util/time');

/**
 * Interaction dispatcher.
 *
 * Four interaction kinds arrive on this event and each needs different
 * handling. Autocomplete in particular must answer within three seconds and
 * must never be sent an error embed - responding to it with a normal reply
 * throws, which is why it is checked first and returns early.
 *
 * The guard order below is deliberate: cheap, local checks run before anything
 * that touches the network, and the cooldown is consumed last so a command that
 * was rejected for permissions does not also burn the user's cooldown.
 */

module.exports = {
  name: 'interactionCreate',

  async execute(bot, interaction) {
    bot.counters.interactions++;

    // ---------- autocomplete ----------
    if (interaction.isAutocomplete()) {
      const command = bot.registry.get(interaction.commandName);
      if (!command?.autocomplete) return interaction.respond([]).catch(() => {});
      try {
        const ctx = new Context(bot, interaction);
        await command.autocomplete(ctx);
      } catch (e) {
        bot.log.debug(`autocomplete for /${interaction.commandName} failed: ${e.message}`);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // ---------- buttons, selects, modals ----------
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      if (bot.db.isBlacklisted(interaction.user.id)) {
        return interaction
          .reply({ content: bot.t(interaction.guildId)('err.blacklisted'), flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      try {
        const ctx = new Context(bot, interaction);
        const handled = await bot.components.dispatch(interaction, ctx);
        if (!handled) {
          // An unrouted component is almost always a message left over from an
          // older version of the bot. Say so rather than failing silently.
          await interaction
            .reply({
              content: 'These controls belong to an older version of the bot and no longer work. Run the command again.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
      } catch (e) {
        bot.counters.errors++;
        bot.log.error(`component "${interaction.customId}" threw:`, e);
        const payload = { content: `That control failed: ${e.message}`, flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const t = bot.t(interaction.guildId);
    const command = bot.registry.get(interaction.commandName);

    if (!command) {
      // Registered with Discord but missing locally: a stale global command.
      bot.log.warn(`received unknown command /${interaction.commandName}`);
      return interaction
        .reply({ content: 'That command no longer exists. It should disappear shortly.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    // ---------- blacklist ----------
    if (bot.db.isBlacklisted(interaction.user.id) && !bot.isOwner(interaction.user.id)) {
      return interaction.reply({ content: t('err.blacklisted'), flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    // ---------- context ----------
    if (command.guildOnly && !interaction.inGuild()) {
      return interaction.reply({ content: t('err.guildOnly'), flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    if (command.ownerOnly && !bot.isOwner(interaction.user.id)) {
      return interaction.reply({ content: t('err.ownerOnly'), flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    // ---------- per-guild switches ----------
    if (interaction.inGuild()) {
      const settings = bot.db.settings(interaction.guildId);

      if (settings.disabledCommands?.includes(command.data.name) && !perms.isStaff(interaction.member)) {
        return interaction.reply({ content: t('err.disabled'), flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      const channelBlocks = settings.disabledChannels?.[interaction.channelId] || [];
      if (channelBlocks.includes(command.data.name) && !perms.isStaff(interaction.member)) {
        return interaction.reply({ content: t('err.disabledHere'), flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      // A feature-gated command checks both the global switch and the guild one,
      // so /balance in a server with the economy off explains itself instead of
      // creating an account nobody asked for.
      if (command.feature && !bot.featureEnabled(interaction.guildId, command.feature)) {
        return interaction
          .reply({ content: t('err.featureOff', { feature: command.feature }), flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }

    // ---------- permissions ----------
    if (interaction.inGuild() && command.userPerms.length) {
      const missing = perms.missing(interaction.member, command.userPerms, interaction.channel);
      if (missing.length && !bot.isOwner(interaction.user.id)) {
        return interaction
          .reply({
            content: t('err.userPerms', { perms: perms.names(missing).join(', ') }),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }

    if (interaction.inGuild() && command.botPerms.length) {
      const missing = perms.missing(interaction.guild.members.me, command.botPerms, interaction.channel);
      if (missing.length) {
        return interaction
          .reply({
            content: t('err.botPerms', { perms: perms.names(missing).join(', ') }),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }

    // The bot needs Embed Links for essentially every reply it makes. Checking
    // once here turns a confusing silent failure into one clear sentence.
    if (interaction.inGuild() && !interaction.guild.members.me.permissionsIn(interaction.channel).has(PermissionFlagsBits.EmbedLinks)) {
      return interaction
        .reply({ content: t('err.botPerms', { perms: 'Embed Links' }), flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    // ---------- rate limiting ----------
    if (!bot.isOwner(interaction.user.id)) {
      const penalty = bot.cooldowns.guard(interaction.user.id);
      if (penalty > 0) {
        return interaction
          .reply({
            content: t('err.ratelimited', { time: relative(Date.now() + penalty) }),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }

      const remaining = bot.cooldowns.check(interaction.user.id, command.data.name, command.cooldown);
      if (remaining > 0) {
        return interaction
          .reply({
            content: t('err.cooldown', {
              command: command.data.name,
              time: relative(Date.now() + remaining),
            }),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }

    // ---------- execute ----------
    const started = Date.now();
    try {
      const ctx = new Context(bot, interaction);
      await command.execute(ctx);

      command.uses++;
      bot.counters.commands++;
      bot.db.recordCommand(command.data.name);
      if (interaction.inGuild()) bot.db.stores.guilds.add(`${interaction.guildId}.stats.commandsUsed`, 1);

      const took = Date.now() - started;
      if (took > 3000) bot.log.warn(`/${command.data.name} took ${took}ms`);
      else bot.log.debug(`/${command.data.name} by ${interaction.user.tag} (${took}ms)`);

      // Optional audit trail for servers that want one.
      bot.features.logging?.commandUsed?.(interaction, command, took);
    } catch (e) {
      bot.counters.errors++;
      bot.log.error(`/${command.data.name} threw:`, e);

      // A command that failed should not hold the user's cooldown hostage.
      bot.cooldowns.clear(interaction.user.id, command.data.name);

      const payload = {
        content: t('err.generic', { error: e.message || 'unknown error' }),
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
