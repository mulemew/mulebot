'use strict';

const embeds = require('../util/embeds');
const { truncate } = require('../util/text');

/**
 * Starboard.
 *
 * A message that collects enough of the configured reaction is mirrored into a
 * showcase channel, and the mirror's count is kept up to date as reactions come
 * and go.
 *
 * The mapping from source message to starboard message is persisted, because
 * without it a restart would post a duplicate the next time anyone reacted to
 * an already-featured message.
 */

function init(bot) {
  const log = bot.log.child('starboard');

  /** Reaction emoji as a comparable string, custom or unicode. */
  function emojiKey(reaction) {
    return reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
  }

  /** Colour shifts from yellow to orange as the count climbs. */
  function colorFor(count, threshold) {
    const ratio = Math.min(1, count / (threshold * 3));
    const r = 0xff;
    const g = Math.round(0xd7 - ratio * 0x77);
    return (r << 16) | (g << 8) | 0x00;
  }

  const api = {
    /**
     * Called for every reaction add and remove.
     * @param {import('discord.js').MessageReaction} reaction
     */
    async onReaction(reaction) {
      if (!bot.config.features.starboard) return;

      // Reactions on messages from before this process started arrive partial.
      if (reaction.partial) {
        const ok = await reaction.fetch().then(() => true).catch(() => false);
        if (!ok) return;
      }
      const message = reaction.message;
      if (message.partial) {
        const ok = await message.fetch().then(() => true).catch(() => false);
        if (!ok) return;
      }
      if (!message.guild) return;

      const settings = bot.db.settings(message.guild.id);
      const board = settings.starboard;
      if (!board.enabled || !board.channelId) return;
      if (emojiKey(reaction) !== board.emoji) return;
      if (board.ignoredChannels.includes(message.channelId)) return;
      if (board.ignoreBots && message.author?.bot) return;
      if (message.channelId === board.channelId) return; // never star the starboard
      if (message.channel.nsfw && !board.nsfwAllowed) return;

      let count = reaction.count || 0;
      // Self-stars are excluded by fetching the reactors, which costs a request;
      // only do it when the setting actually calls for it.
      if (!board.selfStar && message.author) {
        const users = await reaction.users.fetch().catch(() => null);
        if (users?.has(message.author.id)) count -= 1;
      }

      const key = `${message.guild.id}.${message.id}`;
      const existing = bot.db.stores.starboard.get(key, null);

      if (count < board.threshold) {
        // Dropped below the bar: remove the mirror rather than leaving a stale one.
        if (existing) await api.remove(message.guild, key, existing);
        return;
      }

      if (existing) await api.update(message.guild, key, existing, count, board);
      else await api.create(message, count, board);
    },

    /** Posts a new starboard entry. */
    async create(message, count, board) {
      const embed = api.render(message, count, board);
      const posted = await bot.sendTo(message.guild, board.channelId, {
        content: `${board.emoji} **${count}** · <#${message.channelId}>`,
        embeds: [embed],
      });
      if (!posted) {
        log.debug(`could not post to starboard channel ${board.channelId}`);
        return;
      }
      bot.db.stores.starboard.set(`${message.guild.id}.${message.id}`, {
        starMessageId: posted.id,
        channelId: message.channelId,
        count,
        at: Date.now(),
      });
    },

    /** Updates the count on an existing entry. */
    async update(guild, key, entry, count, board) {
      if (entry.count === count) return;
      const channel = await bot.resolveChannel(guild, board.channelId);
      if (!channel) return;
      const starMessage = await channel.messages.fetch(entry.starMessageId).catch(() => null);
      if (!starMessage) {
        // Somebody deleted the mirror by hand; forget it so it can be recreated.
        bot.db.stores.starboard.delete(key);
        return;
      }
      entry.count = count;
      bot.db.stores.starboard.set(key, entry);

      const embed = starMessage.embeds[0];
      await starMessage
        .edit({
          content: `${board.emoji} **${count}** · <#${entry.channelId}>`,
          embeds: embed ? [{ ...embed.data, color: colorFor(count, board.threshold) }] : [],
        })
        .catch(() => {});
    },

    /** Deletes an entry that fell below the threshold. */
    async remove(guild, key, entry) {
      const settings = bot.db.settings(guild.id);
      const channel = await bot.resolveChannel(guild, settings.starboard.channelId);
      if (channel) {
        const starMessage = await channel.messages.fetch(entry.starMessageId).catch(() => null);
        await starMessage?.delete().catch(() => {});
      }
      bot.db.stores.starboard.delete(key);
    },

    /** Builds the mirrored embed. */
    render(message, count, board) {
      const embed = embeds
        .base(null, truncate(message.content || '', 4000), colorFor(count, board.threshold))
        .setAuthor({
          name: message.author?.tag || 'unknown',
          iconURL: message.author?.displayAvatarURL({ size: 128 }),
        })
        .addFields({ name: 'Source', value: `[Jump to message](${message.url})` })
        .setTimestamp(message.createdTimestamp);

      // Mirror the first image so the entry is useful on its own.
      const image = [...message.attachments.values()].find((a) => a.contentType?.startsWith('image/'));
      if (image) embed.setImage(image.url);
      else if (message.embeds[0]?.image) embed.setImage(message.embeds[0].image.url);
      else if (message.embeds[0]?.thumbnail) embed.setImage(message.embeds[0].thumbnail.url);

      return embed;
    },

    /** Top starred messages, used by /starboard top. */
    top(guildId, limit = 10) {
      const all = bot.db.stores.starboard.get(guildId, {});
      return Object.entries(all)
        .map(([messageId, entry]) => ({ messageId, ...entry }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    },

    /** Forgets every entry for a guild, used when reconfiguring. */
    reset(guildId) {
      const count = Object.keys(bot.db.stores.starboard.get(guildId, {})).length;
      bot.db.stores.starboard.delete(guildId);
      return count;
    },
  };

  return api;
}

module.exports = { name: 'starboard', init };
