'use strict';

/**
 * Message delete and edit events, feeding the audit log and the snipe buffer.
 *
 * Partial handling matters here more than anywhere else: a delete event for a
 * message the bot never cached (anything sent before the last restart) arrives
 * with almost no data. Rather than logging a useless "unknown user deleted
 * unknown content", those are skipped, and the reason is documented so the
 * behaviour does not look like a bug.
 */

module.exports = [
  {
    name: 'messageDelete',
    async execute(bot, message) {
      if (!message.guild) return;
      // A partial message has no author and no content; there is nothing to log.
      if (message.partial) return;
      if (message.author?.bot) return;
      if (bot.features.logging?.ignored(message.guild, { channelId: message.channelId, userId: message.author?.id })) {
        return;
      }

      bot.features.snipe?.onDelete(message);
      await bot.features.logging?.post(message.guild, 'messageDelete', bot.features.logging.messageDeleted(message));
    },
  },

  {
    name: 'messageUpdate',
    async execute(bot, before, after) {
      if (!after.guild) return;
      if (before.partial || after.partial) return;
      if (after.author?.bot) return;
      // Embed hydration on a link fires an update with identical content.
      if (before.content === after.content) return;
      if (bot.features.logging?.ignored(after.guild, { channelId: after.channelId, userId: after.author?.id })) return;

      bot.features.snipe?.onEdit(before, after);
      await bot.features.logging?.post(after.guild, 'messageUpdate', bot.features.logging.messageEdited(before, after));

      // An edit is the classic way to slip a filtered link past automod: post
      // something innocent, then edit it. Re-inspecting closes that hole.
      try {
        await bot.features.automod?.inspect(after);
      } catch (e) {
        bot.log.error('automod re-inspection failed:', e);
      }
    },
  },

  {
    name: 'messageDeleteBulk',
    async execute(bot, messages, channel) {
      if (!channel?.guild) return;
      if (bot.features.logging?.ignored(channel.guild, { channelId: channel.id })) return;
      await bot.features.logging?.post(
        channel.guild,
        'messageBulkDelete',
        bot.features.logging.bulkDeleted(channel, messages.size),
      );
    },
  },
];
