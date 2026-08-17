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

        // Same two "the interaction is gone" cases as commands below. Buttons
        // hit them more often, because a game board sits there being clickable
        // long after the process has started struggling.
        if (e?.code === 10062) {
          bot.log.warn(
            `component "${interaction.customId}" could not answer: Discord had already expired the ` +
              `interaction, ${Date.now() - interaction.createdTimestamp}ms after it was created`,
          );
          return;
        }
        if (e?.code === 40060) {
          bot.log.warn(
            `component "${interaction.customId}" was already answered by somebody else — ` +
              'that normally means a second copy of the bot is running on the same token',
          );
          return;
        }

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
      // "Restricted to the bot owner" is useless on its own when the reader is
      // the bot owner and the bot simply has not been told. Say what would fix
      // it, and say it differently depending on which case this is.
      // Saying nothing more than "restricted to the bot owner" is useless in
      // both directions: the reader cannot tell whether the bot failed to work
      // out who owns it, or worked it out and decided it is not them. Which of
      // those it is changes what they should do, so say which. Other owners'
      // ids are deliberately not listed - the count answers the question and
      // whoever is asking is, by definition, not an owner.
      const known = new Set([...bot.config.owners, ...bot.applicationOwners]);
      const detail = known.size
        ? `\n\nYour user ID is \`${interaction.user.id}\`, which is not among the ` +
          `${known.size} the bot recognises. If this bot is yours, add ` +
          `\`OWNER_IDS=${interaction.user.id}\` to your environment or \`.env\` and restart.`
        : '\n\nI could not work out who owns this application, and `OWNER_IDS` is not set. ' +
          `Add \`OWNER_IDS=${interaction.user.id}\` to your environment or \`.env\` and restart.`;

      return interaction
        .reply({ content: t('err.ownerOnly') + detail, flags: MessageFlags.Ephemeral })
        .catch(() => {});
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

      // A command that failed should not hold the user's cooldown hostage.
      bot.cooldowns.clear(interaction.user.id, command.data.name);

      // Two API errors mean the interaction itself is gone rather than the
      // command being broken. A stack trace for either is noise, and there is
      // nobody left to apologise to, so both return early.
      if (e?.code === 10062) {
        // Discord expires an interaction token three seconds after the user
        // pressed enter. That clock starts before the event reaches this
        // process, so the useful question is where the three seconds went.
        const queued = started - interaction.createdTimestamp;
        const total = Date.now() - interaction.createdTimestamp;
        bot.log.warn(
          `/${command.data.name} could not answer: Discord had already expired the interaction. ` +
            `${queued}ms passed before the handler started, ${total - queued}ms inside it.`,
        );
        bot.log.warn(
          queued > 2000
            ? '  the delay is before any command code runs, so this is the process being stalled or the ' +
                'gateway lagging — check for "the process was unresponsive" warnings, and make sure ' +
                '--max-old-space-size is set if this host is memory-limited'
            : `  the command itself was too slow (${total - queued}ms); it should defer before doing work`,
        );
        return;
      }

      if (e?.code === 40060) {
        bot.log.warn(
          `/${command.data.name}: this interaction was already answered by somebody else. ` +
            'That normally means a second copy of the bot is running on the same token.',
        );
        return;
      }

      bot.log.error(`/${command.data.name} threw:`, e);

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
