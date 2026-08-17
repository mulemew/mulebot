'use strict';

const embeds = require('../util/embeds');
const { truncate } = require('../util/text');
const { relative } = require('../util/time');

/**
 * Message sniping - recovering the last deleted or edited message in a channel.
 *
 * This is deliberately memory-only and short-lived. A persistent archive of
 * everything anyone deleted is a privacy problem and, on a busy server, a
 * storage one; a small in-memory ring per channel gives the feature its actual
 * purpose (someone deleted a link by accident) without becoming surveillance.
 *
 * Rules enforced here:
 *   - bot messages and messages in NSFW channels are never captured
 *   - entries expire after 30 minutes
 *   - a member can wipe their own captured messages with /snipe clear
 */

const MAX_PER_CHANNEL = 5;
const TTL_MS = 30 * 60_000;

function init(bot) {
  /** channelId -> array of captures, newest first. */
  const deleted = new Map();
  const edited = new Map();

  function push(map, channelId, entry) {
    const list = map.get(channelId) || [];
    list.unshift(entry);
    map.set(channelId, list.slice(0, MAX_PER_CHANNEL));
  }

  function read(map, channelId, index) {
    const list = (map.get(channelId) || []).filter((e) => Date.now() - e.at < TTL_MS);
    map.set(channelId, list);
    return list[index] || null;
  }

  const sweeper = setInterval(() => {
    for (const map of [deleted, edited]) {
      for (const [channelId, list] of map) {
        const live = list.filter((e) => Date.now() - e.at < TTL_MS);
        if (live.length) map.set(channelId, live);
        else map.delete(channelId);
      }
    }
  }, 5 * 60_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function capturable(message) {
    if (!message.guild) return false;
    if (message.author?.bot) return false;
    if (message.channel?.nsfw) return false;
    if (!message.content && !message.attachments?.size) return false;
    return true;
  }

  const api = {
    onDelete(message) {
      if (!capturable(message)) return;
      push(deleted, message.channelId, {
        at: Date.now(),
        authorId: message.author.id,
        authorTag: message.author.tag,
        avatar: message.author.displayAvatarURL({ size: 128 }),
        content: truncate(message.content || '', 3000),
        attachments: [...message.attachments.values()].map((a) => a.name),
        createdAt: message.createdTimestamp,
      });
    },

    onEdit(before, after) {
      if (!capturable(after)) return;
      if (before.content === after.content) return;
      push(edited, after.channelId, {
        at: Date.now(),
        authorId: after.author.id,
        authorTag: after.author.tag,
        avatar: after.author.displayAvatarURL({ size: 128 }),
        before: truncate(before.content || '(empty)', 1500),
        after: truncate(after.content || '(empty)', 1500),
        url: after.url,
      });
    },

    /** Renders a snipe result, or null when nothing is stored. */
    render(channelId, { kind = 'delete', index = 0 } = {}) {
      const entry = kind === 'edit' ? read(edited, channelId, index) : read(deleted, channelId, index);
      if (!entry) return null;

      if (kind === 'edit') {
        return embeds
          .base('Edited message', `[Jump to message](${entry.url})`, embeds.theme.warning)
          .setAuthor({ name: entry.authorTag, iconURL: entry.avatar })
          .addFields(
            { name: 'Before', value: truncate(entry.before, 1024) },
            { name: 'After', value: truncate(entry.after, 1024) },
          )
          .setFooter({ text: `Edited ${new Date(entry.at).toLocaleTimeString()}` });
      }

      const embed = embeds
        .base('Deleted message', entry.content || '*(no text)*', embeds.theme.danger)
        .setAuthor({ name: entry.authorTag, iconURL: entry.avatar })
        .setFooter({ text: `Deleted ${new Date(entry.at).toLocaleTimeString()}` });
      if (entry.attachments.length) {
        embed.addFields({ name: 'Attachments', value: entry.attachments.join(', ').slice(0, 1024) });
      }
      embed.addFields({ name: 'Originally sent', value: relative(entry.createdAt), inline: true });
      return embed;
    },

    /** How many captures are stored for a channel. */
    count(channelId) {
      const d = (deleted.get(channelId) || []).filter((e) => Date.now() - e.at < TTL_MS).length;
      const e = (edited.get(channelId) || []).filter((x) => Date.now() - x.at < TTL_MS).length;
      return { deleted: d, edited: e };
    },

    /** Removes every capture authored by a user, across all channels. */
    forget(userId) {
      let removed = 0;
      for (const map of [deleted, edited]) {
        for (const [channelId, list] of map) {
          const kept = list.filter((e) => e.authorId !== userId);
          removed += list.length - kept.length;
          if (kept.length) map.set(channelId, kept);
          else map.delete(channelId);
        }
      }
      return removed;
    },

    /** Clears a channel's captures, used by moderators after an incident. */
    clearChannel(channelId) {
      const count = (deleted.get(channelId)?.length || 0) + (edited.get(channelId)?.length || 0);
      deleted.delete(channelId);
      edited.delete(channelId);
      return count;
    },

    shutdown() {
      clearInterval(sweeper);
      deleted.clear();
      edited.clear();
    },
  };

  return api;
}

module.exports = { name: 'snipe', init, TTL_MS, MAX_PER_CHANNEL };
