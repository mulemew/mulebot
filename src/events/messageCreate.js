'use strict';

/**
 * messageCreate is the hottest path in the bot: on a busy server it fires
 * thousands of times an hour, and every feature wants a look.
 *
 * Two rules keep it cheap:
 *
 *   1. The cheapest rejections come first - bots, DMs, and the message content
 *      intent check - so the common case of "a normal message in a server with
 *      no message features enabled" costs almost nothing.
 *   2. Features run in a fixed order and the first one to consume the message
 *      stops the chain. Automod runs before everything, because awarding XP for
 *      a message that is about to be deleted for advertising is absurd.
 */

module.exports = {
  name: 'messageCreate',

  async execute(bot, message) {
    if (message.author?.bot) return;
    if (!message.guild) return; // DMs are not a supported surface

    bot.counters.messages++;

    // Without the MESSAGE CONTENT intent, message.content is an empty string for
    // messages that do not mention the bot. Every feature below needs the text,
    // so bail out rather than running them against nothing.
    if (!bot.intents.messageContent) return;

    bot.db.stores.guilds.add(`${message.guildId}.stats.messagesSeen`, 1);

    // ---------- automod ----------
    // Runs first and short-circuits: a deleted message should not earn XP,
    // coins, or trigger an auto-responder.
    try {
      const violation = await bot.features.automod?.inspect(message);
      if (violation) return;
    } catch (e) {
      bot.log.error('automod failed:', e);
    }

    // ---------- counting ----------
    // Owns its channel entirely, so it returns early when it handled the message.
    try {
      if (await bot.features.counting?.onMessage(message)) return;
    } catch (e) {
      bot.log.error('counting failed:', e);
    }

    // ---------- afk ----------
    // Never consumes the message: someone returning from AFK still earns XP.
    try {
      await bot.features.afk?.onMessage(message);
    } catch (e) {
      bot.log.error('afk failed:', e);
    }

    // ---------- prefix commands ----------
    try {
      if (await bot.features.prefix?.onMessage(message)) return;
    } catch (e) {
      bot.log.error('prefix bridge failed:', e);
    }

    // ---------- auto-responders ----------
    try {
      await bot.features.autoresponder?.onMessage(message);
    } catch (e) {
      bot.log.error('autoresponder failed:', e);
    }

    // ---------- levelling ----------
    try {
      await bot.features.leveling?.onMessage(message);
    } catch (e) {
      bot.log.error('leveling failed:', e);
    }

    // ---------- economy drops ----------
    try {
      const dropped = bot.features.economy?.maybeDrop(message);
      if (dropped) {
        const settings = bot.db.settings(message.guildId);
        await message
          .react(settings.economy.currency.match(/^\p{Extended_Pictographic}$/u) ? settings.economy.currency : '🪙')
          .catch(() => {});
      }
    } catch (e) {
      bot.log.error('economy drop failed:', e);
    }
  },
};
