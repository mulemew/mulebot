'use strict';

const embeds = require('../util/embeds');
const mathexpr = require('../util/mathexpr');

/**
 * The counting channel game.
 *
 * Members count upwards, one number per message, and nobody may go twice in a
 * row. Simple in principle, and almost always implemented in a way that breaks:
 *
 *   - the state must be written before the reaction is added, otherwise two
 *     messages arriving at once both read the same "current" value and the
 *     count silently forks
 *   - a member editing their message to the right number after the fact should
 *     not count, which is why only the original content is inspected
 *   - expressions are allowed ("7*6" for 42) because it makes the channel more
 *     interesting, evaluated through the safe parser rather than eval
 */

function init(bot) {
  const log = bot.log.child('counting');

  /**
   * Per-guild lock. Node is single threaded, but an await inside the handler is
   * a yield point, so two messages really can interleave. A simple flag closes
   * that window without pulling in a mutex library.
   */
  const busy = new Set();

  /** Parses a message as a number, allowing arithmetic. */
  function parseNumber(content) {
    const trimmed = content.trim().split(/\s+/)[0];
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    // Only try the expression parser when it looks like maths, so a normal
    // sentence does not pay the parsing cost.
    if (!/^[\d\s+\-*/().^%]+$/.test(trimmed)) return null;
    const result = mathexpr.evaluate(trimmed);
    if (!result.ok || !Number.isInteger(result.value)) return null;
    return result.value;
  }

  const api = {
    /** Current state for a guild. */
    state(guildId) {
      const s = bot.db.settings(guildId).counting;
      return { current: s.current, best: s.best, lastUserId: s.lastUserId, channelId: s.channelId };
    },

    /** Resets the count, optionally keeping the record. */
    reset(guildId, { keepBest = true } = {}) {
      bot.db.patchSettings(guildId, {
        'counting.current': 0,
        'counting.lastUserId': null,
        ...(keepBest ? {} : { 'counting.best': 0 }),
      });
    },

    /**
     * Message hook.
     * @returns {Promise<boolean>} whether the message was part of the game
     */
    async onMessage(message) {
      if (!message.guild || message.author.bot) return false;
      if (!bot.config.features.counting) return false;

      const settings = bot.db.settings(message.guildId);
      const cfg = settings.counting;
      if (!cfg.enabled || cfg.channelId !== message.channelId) return false;

      const value = parseNumber(message.content);
      if (value === null) return false; // chatter in the counting channel is ignored

      if (busy.has(message.guildId)) {
        // Another message is mid-processing; rejecting is safer than guessing.
        await message.react('⏳').catch(() => {});
        return true;
      }
      busy.add(message.guildId);

      try {
        const expected = cfg.current + 1;
        const sameUser = cfg.lastUserId === message.author.id && !cfg.allowSameUser;

        if (value !== expected || sameUser) {
          const reason = sameUser ? 'you cannot count twice in a row' : `the next number was **${expected}**`;

          if (cfg.resetOnFail) {
            const reached = cfg.current;
            const best = Math.max(cfg.best || 0, reached);
            bot.db.patchSettings(message.guildId, {
              'counting.current': 0,
              'counting.lastUserId': null,
              'counting.best': best,
            });
            await message.react('❌').catch(() => {});
            await message.channel
              .send({
                embeds: [
                  embeds.error(
                    'Count broken',
                    `<@${message.author.id}> broke the chain at **${reached}** — ${reason}.\n` +
                      `Back to **1**. Server record: **${best}**.`,
                  ),
                ],
                allowedMentions: { parse: [] },
              })
              .catch(() => {});
          } else {
            await message.react('❌').catch(() => {});
          }
          return true;
        }

        // Persist first, react second: if the process dies between the two, the
        // count is correct and merely missing a tick, rather than duplicated.
        const best = Math.max(cfg.best || 0, value);
        bot.db.patchSettings(message.guildId, {
          'counting.current': value,
          'counting.lastUserId': message.author.id,
          'counting.best': best,
        });

        const record = bot.db.member(message.guildId, message.author.id);
        record.counting = (record.counting || 0) + 1;
        bot.db.saveMember();

        // Milestones get a distinct reaction so the channel has some texture.
        let emoji = '✅';
        if (value % 1000 === 0) emoji = '🎉';
        else if (value % 100 === 0) emoji = '💯';
        else if (value === best && value > (cfg.best || 0)) emoji = '🏆';
        await message.react(emoji).catch(() => {});

        return true;
      } catch (e) {
        log.warn(`counting failed in ${message.guild.name}: ${e.message}`);
        return false;
      } finally {
        busy.delete(message.guildId);
      }
    },

    /** Leaderboard of who has contributed most numbers. */
    leaderboard(guildId, limit = 10) {
      return bot.db.leaderboard(guildId, (r) => r.counting || 0, limit);
    },
  };

  return api;
}

module.exports = { name: 'counting', init };
