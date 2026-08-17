'use strict';

const { PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const { parseDuration, formatDuration, fullTimestamp } = require('../util/time');
const { truncate } = require('../util/text');

/**
 * Moderation case log and punishment plumbing.
 *
 * Commands perform the Discord-side action (kick, ban, timeout); this module
 * owns everything that surrounds it - recording the case, notifying the member,
 * posting to the mod log, and running warning thresholds. Keeping that here
 * means /warn and the automod escalation produce identical, comparable records
 * instead of two parallel histories.
 */

const ACTION_LABELS = {
  warn: 'warned',
  mute: 'muted',
  timeout: 'timed out',
  kick: 'kicked',
  ban: 'banned',
  softban: 'softbanned',
  unban: 'unbanned',
  untimeout: 'untimed out',
  note: 'noted',
  automod: 'flagged by automod',
};

const ACTION_COLORS = {
  warn: 0xfee75c,
  timeout: 0xe67e22,
  mute: 0xe67e22,
  kick: 0xed4245,
  ban: 0x992d22,
  softban: 0xed4245,
  unban: 0x57f287,
  untimeout: 0x57f287,
  note: 0x95a5a6,
  automod: 0x9b59b6,
};

function init(bot) {
  const log = bot.log.child('moderation');

  const api = {
    ACTION_LABELS,

    /**
     * Records a case, notifies the target and posts to the mod log.
     *
     * @param {import('discord.js').Guild} guild
     * @param {{ type: string, user: object, moderator?: object, reason?: string,
     *           duration?: number, notify?: boolean, extra?: object }} opts
     * @returns {Promise<object>} the stored case
     */
    async record(guild, opts) {
      const settings = bot.db.settings(guild.id);
      const reason = truncate(opts.reason || 'No reason provided', 500);

      const entry = bot.db.addCase(guild.id, {
        type: opts.type,
        userId: opts.user.id,
        userTag: opts.user.tag || opts.user.username || opts.user.id,
        moderatorId: opts.moderator?.id || null,
        moderatorTag: opts.moderator?.tag || 'automod',
        reason,
        duration: opts.duration || 0,
        ...(opts.extra || {}),
      });

      // DM the member before anything else: a ban removes the shared server, and
      // after that the bot can no longer open a DM channel with them at all.
      if (opts.notify !== false && settings.moderation.dmOnPunish) {
        await api.notify(guild, opts.user, entry).catch(() => {});
      }

      await api.postToModLog(guild, entry, opts.user, opts.moderator).catch((e) =>
        log.debug(`mod log post failed: ${e.message}`),
      );

      return entry;
    },

    /** Sends the "you were X in Y" DM. Failure is expected and ignored. */
    async notify(guild, user, entry) {
      if (typeof user.send !== 'function') return null;
      const settings = bot.db.settings(guild.id);
      const label = ACTION_LABELS[entry.type] || entry.type;

      const embed = embeds
        .base(`You were ${label} in ${guild.name}`, null, ACTION_COLORS[entry.type] || embeds.theme.warning)
        .addFields({ name: 'Reason', value: entry.reason });

      if (entry.duration) {
        embed.addFields({
          name: 'Duration',
          value: `${formatDuration(entry.duration)} (until ${fullTimestamp(Date.now() + entry.duration)})`,
        });
      }
      embed.setFooter({ text: `Case #${entry.id}` });
      if (settings.moderation.appealLink) {
        embed.addFields({ name: 'Appeal', value: settings.moderation.appealLink });
      }

      return user.send({ embeds: [embed] });
    },

    /** Posts a case to the configured moderation log channel. */
    async postToModLog(guild, entry, user, moderator) {
      const settings = bot.db.settings(guild.id);
      const channelId = settings.moderation.logChannelId || settings.logging.channelId;
      if (!channelId) return null;

      const embed = embeds
        .base(`Case #${entry.id} · ${entry.type}`, null, ACTION_COLORS[entry.type] || embeds.theme.primary)
        .addFields(
          { name: 'Member', value: `${user.tag || user.username} (\`${user.id}\`)`, inline: true },
          { name: 'Moderator', value: moderator ? `${moderator.tag} (\`${moderator.id}\`)` : 'Automod', inline: true },
          { name: 'Reason', value: entry.reason },
        );
      if (entry.duration) embed.addFields({ name: 'Duration', value: formatDuration(entry.duration), inline: true });
      if (typeof user.displayAvatarURL === 'function') embed.setThumbnail(user.displayAvatarURL({ size: 128 }));

      return bot.sendTo(guild, channelId, { embeds: [embed] });
    },

    /** Every case filed against a member. */
    history(guildId, userId) {
      return bot.db.casesFor(guildId, userId);
    },

    /** Count of active warnings, i.e. cases of type warn. */
    warnCount(guildId, userId) {
      return bot.db.casesFor(guildId, userId, 'warn').length;
    },

    /**
     * Evaluates the configured warning thresholds after a warn.
     * Threshold values are strings: "timeout:1h", "kick", "ban".
     * @returns {Promise<string|null>} description of the action taken
     */
    async runThresholds(guild, member, moderator) {
      const settings = bot.db.settings(guild.id);
      const thresholds = settings.moderation.warnThresholds || {};
      if (!Object.keys(thresholds).length) return null;

      const count = api.warnCount(guild.id, member.id);
      const rule = thresholds[String(count)];
      if (!rule) return null;

      const [action, arg] = String(rule).split(':');
      const reason = `Reached ${count} warnings`;

      try {
        switch (action) {
          case 'timeout': {
            const ms = parseDuration(arg || '1h') || 3_600_000;
            if (!guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) return null;
            await member.timeout(Math.min(ms, 28 * 86_400_000), reason);
            await api.record(guild, { type: 'timeout', user: member.user, moderator, reason, duration: ms });
            return `timed out for ${formatDuration(ms)}`;
          }
          case 'kick': {
            if (!guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return null;
            await api.record(guild, { type: 'kick', user: member.user, moderator, reason });
            await member.kick(reason);
            return 'kicked';
          }
          case 'ban': {
            if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return null;
            await api.record(guild, { type: 'ban', user: member.user, moderator, reason });
            await member.ban({ reason });
            return 'banned';
          }
          default:
            log.warn(`unknown warn threshold action "${action}"`);
            return null;
        }
      } catch (e) {
        log.warn(`warn threshold action failed: ${e.message}`);
        return null;
      }
    },

    /**
     * Applies an action by name. Used by automod, which decides on an action
     * string from configuration rather than from a command.
     */
    async apply(action, member, { reason, durationMs, moderator } = {}) {
      const guild = member.guild;
      const me = guild.members.me;

      try {
        switch (action) {
          case 'warn':
            await api.record(guild, { type: 'warn', user: member.user, moderator, reason });
            return true;

          case 'timeout': {
            if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) return false;
            if (member.roles.highest.position >= me.roles.highest.position) return false;
            const ms = Math.min(durationMs || 300_000, 28 * 86_400_000);
            await member.timeout(ms, reason);
            await api.record(guild, { type: 'timeout', user: member.user, moderator, reason, duration: ms });
            return true;
          }

          case 'kick': {
            if (!me.permissions.has(PermissionFlagsBits.KickMembers)) return false;
            if (!member.kickable) return false;
            await api.record(guild, { type: 'kick', user: member.user, moderator, reason });
            await member.kick(reason);
            return true;
          }

          case 'ban': {
            if (!me.permissions.has(PermissionFlagsBits.BanMembers)) return false;
            if (!member.bannable) return false;
            await api.record(guild, { type: 'ban', user: member.user, moderator, reason });
            await member.ban({ reason, deleteMessageSeconds: 0 });
            return true;
          }

          case 'delete':
          case 'none':
            return true;

          default:
            log.warn(`unknown moderation action "${action}"`);
            return false;
        }
      } catch (e) {
        log.warn(`action ${action} on ${member.id} failed: ${e.message}`);
        return false;
      }
    },

    /**
     * Ban that deletes recent messages and immediately unbans, i.e. a kick that
     * also cleans up. Discord has no native softban.
     */
    async softban(guild, user, { reason, days = 1, moderator } = {}) {
      await guild.members.ban(user.id, {
        reason: `Softban: ${reason}`,
        deleteMessageSeconds: Math.min(7, days) * 86_400,
      });
      await guild.members.unban(user.id, 'Softban: automatic unban').catch(() => {});
      return api.record(guild, { type: 'softban', user, moderator, reason });
    },

    /** Renders one case as an embed, used by /case view. */
    renderCase(entry) {
      const embed = embeds
        .base(`Case #${entry.id} · ${entry.type}`, entry.reason, ACTION_COLORS[entry.type] || embeds.theme.primary)
        .addFields(
          { name: 'Member', value: `${entry.userTag || 'unknown'} (\`${entry.userId}\`)`, inline: true },
          { name: 'Moderator', value: entry.moderatorTag || 'unknown', inline: true },
          { name: 'When', value: fullTimestamp(entry.at) },
        );
      if (entry.duration) embed.addFields({ name: 'Duration', value: formatDuration(entry.duration), inline: true });
      if (entry.imported) embed.setFooter({ text: 'Imported from the previous single-file bot' });
      return embed;
    },
  };

  // ---------- scheduled reversals ----------
  // A temporary ban is a ban plus a task. Registering the handler here keeps the
  // knowledge of how to reverse an action next to the code that applies it.

  bot.scheduler.register('unban', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    if (!guild) return;
    await guild.members.unban(task.data.userId, 'Temporary ban expired').catch(() => {});
    const user = await bot.client.users.fetch(task.data.userId).catch(() => null);
    if (user) {
      await api.record(guild, { type: 'unban', user, reason: 'Temporary ban expired', notify: false });
    }
  });

  bot.scheduler.register('unmute', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    if (!guild) return;
    const member = await guild.members.fetch(task.data.userId).catch(() => null);
    if (!member) return;
    const roleId = bot.db.settings(guild.id).moderation.muteRoleId;
    if (roleId && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, 'Temporary mute expired').catch(() => {});
    }
  });

  bot.scheduler.register('unlock_channel', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    const channel = guild?.channels.cache.get(task.data.channelId);
    if (!channel) return;
    await channel.permissionOverwrites
      .edit(guild.roles.everyone, { SendMessages: null }, { reason: 'Temporary lock expired' })
      .catch(() => {});
  });

  bot.scheduler.register('remove_role', async (task) => {
    const guild = bot.client.guilds.cache.get(task.guildId);
    const member = await guild?.members.fetch(task.data.userId).catch(() => null);
    if (!member) return;
    await member.roles.remove(task.data.roleId, 'Temporary role expired').catch(() => {});
  });

  return api;
}

module.exports = { name: 'moderation', init, ACTION_LABELS, ACTION_COLORS };
