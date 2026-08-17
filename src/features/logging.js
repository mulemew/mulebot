'use strict';

const embeds = require('../util/embeds');
const { truncate, codeBlock } = require('../util/text');
const { fullTimestamp } = require('../util/time');

/**
 * Server audit logging.
 *
 * A single post() entry point handles routing, per-event toggles and the ignore
 * lists, so the event handlers stay dumb: they build an embed and hand it over.
 * Two behaviours are worth calling out:
 *
 *   - a queue with a short flush window batches bursts (a bulk delete, a raid
 *     wave) into fewer messages, because posting one embed per event is the
 *     fastest way to hit Discord's channel rate limit and lose the tail of an
 *     incident, which is exactly the part that mattered
 *   - the log channel itself is always ignored, otherwise a misconfiguration
 *     produces an infinite loop of the bot logging its own log messages
 */

const FLUSH_MS = 1500;
const MAX_BATCH = 10;

function init(bot) {
  const log = bot.log.child('logging');

  /** guildId:channelId -> { embeds: [], timer } */
  const queues = new Map();

  function flush(key) {
    const queue = queues.get(key);
    if (!queue) return;
    queues.delete(key);
    clearTimeout(queue.timer);

    const [guildId, channelId] = key.split(':');
    const guild = bot.client.guilds.cache.get(guildId);
    if (!guild) return;

    // Discord accepts at most 10 embeds per message.
    for (let i = 0; i < queue.embeds.length; i += MAX_BATCH) {
      const slice = queue.embeds.slice(i, i + MAX_BATCH);
      void bot.sendTo(guild, channelId, { embeds: slice });
    }
  }

  const api = {
    /**
     * Queues an embed for the log channel that handles `event`.
     * @param {import('discord.js').Guild} guild
     * @param {string} event key from settings.logging.events
     * @param {import('discord.js').EmbedBuilder} embed
     */
    async post(guild, event, embed) {
      if (!guild || !bot.config.features.logging) return false;
      const settings = bot.db.settings(guild.id);
      if (!settings.logging.enabled) return false;
      if (settings.logging.events[event] === false) return false;

      const channelId = settings.logging.overrides?.[event] || settings.logging.channelId;
      if (!channelId) return false;

      const key = `${guild.id}:${channelId}`;
      let queue = queues.get(key);
      if (!queue) {
        queue = { embeds: [], timer: null };
        queues.set(key, queue);
        queue.timer = setTimeout(() => flush(key), FLUSH_MS);
        if (typeof queue.timer.unref === 'function') queue.timer.unref();
      }
      queue.embeds.push(embed);
      // A burst that fills a whole batch is flushed at once rather than waiting.
      if (queue.embeds.length >= MAX_BATCH) flush(key);
      return true;
    },

    /** True when this channel or user should never produce log entries. */
    ignored(guild, { channelId, userId } = {}) {
      const settings = bot.db.settings(guild.id);
      if (channelId) {
        if (settings.logging.ignoredChannels.includes(channelId)) return true;
        // Never log activity inside the log channel itself.
        if (channelId === settings.logging.channelId) return true;
        if (Object.values(settings.logging.overrides || {}).includes(channelId)) return true;
      }
      if (userId && settings.logging.ignoredUsers.includes(userId)) return true;
      return false;
    },

    /** Consistent header block for member-related entries. */
    memberField(user) {
      return {
        name: 'Member',
        value: `${user.tag || user.username} (<@${user.id}>)\n\`${user.id}\``,
        inline: true,
      };
    },

    // ---------- pre-built entries ----------
    // These live here rather than in the event files so the phrasing and colour
    // of every entry is decided in one place.

    messageDeleted(message) {
      const embed = embeds
        .base('Message deleted', null, embeds.theme.danger)
        .addFields(
          api.memberField(message.author || { id: 'unknown', tag: 'unknown' }),
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
        );
      if (message.content) {
        embed.addFields({ name: 'Content', value: truncate(codeBlock(message.content), 1024) });
      }
      if (message.attachments?.size) {
        embed.addFields({
          name: 'Attachments',
          value: [...message.attachments.values()].map((a) => a.name).join(', ').slice(0, 1024),
        });
      }
      return embed;
    },

    messageEdited(before, after) {
      return embeds
        .base('Message edited', `[Jump to message](${after.url})`, embeds.theme.warning)
        .addFields(
          api.memberField(after.author),
          { name: 'Channel', value: `<#${after.channelId}>`, inline: true },
          { name: 'Before', value: truncate(codeBlock(before.content || '(empty)'), 1024) },
          { name: 'After', value: truncate(codeBlock(after.content || '(empty)'), 1024) },
        );
    },

    bulkDeleted(channel, count) {
      return embeds
        .base('Messages purged', `**${count}** messages were deleted in <#${channel.id}>.`, embeds.theme.danger);
    },

    memberJoined(member) {
      const ageMs = Date.now() - member.user.createdTimestamp;
      const embed = embeds
        .base('Member joined', null, embeds.theme.success)
        .addFields(
          api.memberField(member.user),
          { name: 'Account created', value: fullTimestamp(member.user.createdTimestamp) },
          { name: 'Member count', value: String(member.guild.memberCount), inline: true },
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }));
      // A very new account joining is the single most useful raid signal there
      // is, so it is surfaced rather than left for someone to work out.
      if (ageMs < 7 * 86_400_000) {
        embed.addFields({ name: '⚠️ New account', value: `Created less than 7 days ago.` });
      }
      return embed;
    },

    memberLeft(member) {
      const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => r.name) || [];
      return embeds
        .base('Member left', null, embeds.theme.warning)
        .addFields(
          api.memberField(member.user),
          { name: 'Joined', value: member.joinedTimestamp ? fullTimestamp(member.joinedTimestamp) : 'Unknown' },
          { name: 'Roles', value: truncate(roles.join(', ') || 'None', 1024) },
          { name: 'Member count', value: String(member.guild.memberCount), inline: true },
        );
    },

    memberUpdated(before, after, changes) {
      return embeds
        .base('Member updated', null, embeds.theme.info)
        .addFields(api.memberField(after.user), ...changes);
    },

    channelChanged(channel, action) {
      return embeds.base(`Channel ${action}`, null, embeds.theme.info).addFields(
        { name: 'Channel', value: `${channel.name} (\`${channel.id}\`)`, inline: true },
        { name: 'Type', value: String(channel.type), inline: true },
      );
    },

    roleChanged(role, action) {
      return embeds.base(`Role ${action}`, null, embeds.theme.info).addFields(
        { name: 'Role', value: `${role.name} (\`${role.id}\`)`, inline: true },
        { name: 'Colour', value: `#${role.color.toString(16).padStart(6, '0')}`, inline: true },
      );
    },

    voiceEvent(member, description) {
      return embeds
        .base('Voice', description, embeds.theme.neutral)
        .addFields(api.memberField(member.user));
    },

    /** Optional command audit trail, called by the interaction dispatcher. */
    commandUsed(interaction, command, tookMs) {
      if (!interaction.guild) return;
      const settings = bot.db.settings(interaction.guildId);
      if (!settings.logging.enabled || !settings.logging.events.commandUse) return;

      const options = interaction.options?.data
        ?.map((o) => `${o.name}: ${o.value ?? '(sub)'}`)
        .join(', ');

      void api.post(
        interaction.guild,
        'commandUse',
        embeds
          .base('Command used', `\`/${command.data.name}\``, embeds.theme.neutral)
          .addFields(
            api.memberField(interaction.user),
            { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
            { name: 'Options', value: truncate(options || 'none', 1024) },
            { name: 'Took', value: `${tookMs}ms`, inline: true },
          ),
      );
    },

    shutdown() {
      // Flush anything still queued so the last events before a restart are not
      // silently lost.
      for (const key of [...queues.keys()]) flush(key);
    },
  };

  void log;
  return api;
}

module.exports = { name: 'logging', init };
