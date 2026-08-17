'use strict';

/**
 * Reaction events, shared by the starboard and classic reaction-role panels.
 *
 * Both need Partials.Reaction and Partials.Message to work at all: a reaction on
 * a message sent before the bot last restarted arrives as a partial, and without
 * partials enabled discord.js drops the event entirely. That is the single most
 * common reason a starboard "randomly stops working" after a deploy.
 */

module.exports = [
  {
    name: 'messageReactionAdd',
    async execute(bot, reaction, user) {
      if (user.bot) return;

      try {
        await bot.features.starboard?.onReaction(reaction);
      } catch (e) {
        bot.log.error('starboard failed:', e);
      }

      try {
        await bot.features.reactionroles?.onReaction(reaction, user, 'add');
      } catch (e) {
        bot.log.error('reaction roles failed:', e);
      }
    },
  },

  {
    name: 'messageReactionRemove',
    async execute(bot, reaction, user) {
      if (user.bot) return;

      try {
        await bot.features.starboard?.onReaction(reaction);
      } catch (e) {
        bot.log.error('starboard failed:', e);
      }

      try {
        await bot.features.reactionroles?.onReaction(reaction, user, 'remove');
      } catch (e) {
        bot.log.error('reaction roles failed:', e);
      }
    },
  },

  {
    name: 'messageReactionRemoveAll',
    async execute(bot, message) {
      if (!message.guild) return;
      // Every star is gone, so any starboard entry for this message is stale.
      const key = `${message.guild.id}.${message.id}`;
      const entry = bot.db.stores.starboard.get(key, null);
      if (entry) await bot.features.starboard?.remove(message.guild, key, entry);
    },
  },
];
