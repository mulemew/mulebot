'use strict';

const embeds = require('../util/embeds');
const { relative } = require('../util/time');
const { truncate } = require('../util/text');

/**
 * AFK status.
 *
 * Two behaviours, both driven from messageCreate:
 *   - anyone who mentions an AFK member gets a quiet, single reply explaining
 *     where they went and when
 *   - the AFK member's own next message clears the status automatically, which
 *     is the only way people reliably remember to turn it off
 *
 * Announcements are rate limited per (channel, target) pair so a thread full of
 * pings does not produce ten identical bot messages.
 */

function init(bot) {
  /** `${channelId}:${userId}` -> last announcement timestamp. */
  const announced = new Map();
  const ANNOUNCE_COOLDOWN_MS = 60_000;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ANNOUNCE_COOLDOWN_MS;
    for (const [key, at] of announced) if (at < cutoff) announced.delete(key);
  }, 120_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  const api = {
    /** Marks a member as away. */
    set(guildId, userId, reason, { nickname = null } = {}) {
      const record = bot.db.member(guildId, userId);
      record.afk = {
        reason: truncate(reason || 'Away', 200),
        since: Date.now(),
        previousNickname: nickname,
        mentions: [],
      };
      bot.db.saveMember();
      return record.afk;
    },

    get(guildId, userId) {
      return bot.db.member(guildId, userId).afk;
    },

    /** Clears the status and returns what it was, plus any missed mentions. */
    clear(guildId, userId) {
      const record = bot.db.member(guildId, userId);
      const previous = record.afk;
      record.afk = null;
      bot.db.saveMember();
      return previous;
    },

    /**
     * Message hook. Returns true when it produced a reply, purely so the caller
     * can skip further processing on that message.
     */
    async onMessage(message) {
      if (!message.guild || message.author.bot) return false;

      // ---------- returning ----------
      const own = api.get(message.guildId, message.author.id);
      if (own) {
        api.clear(message.guildId, message.author.id);

        // Restore the [AFK] nickname prefix if one was applied.
        if (own.previousNickname !== null && own.previousNickname !== undefined) {
          await message.member?.setNickname(own.previousNickname, 'AFK cleared').catch(() => {});
        }

        const missed = own.mentions?.length || 0;
        const reply = await message
          .reply({
            embeds: [
              embeds.success(
                'Welcome back',
                `You were away ${relative(own.since)}.` + (missed ? `\nYou were mentioned **${missed}** time(s) while away.` : ''),
              ),
            ],
            allowedMentions: { repliedUser: false },
          })
          .catch(() => null);
        // The notice is transient information; leaving it clutters the channel.
        if (reply) setTimeout(() => reply.delete().catch(() => {}), 15_000);
      }

      // ---------- mentioning someone who is away ----------
      if (!message.mentions.users.size) return false;

      const notes = [];
      for (const user of message.mentions.users.values()) {
        if (user.id === message.author.id || user.bot) continue;
        const afk = api.get(message.guildId, user.id);
        if (!afk) continue;

        // Record the mention so the member sees a count when they return.
        const record = bot.db.member(message.guildId, user.id);
        if (record.afk) {
          record.afk.mentions = (record.afk.mentions || []).slice(-19);
          record.afk.mentions.push({ by: message.author.id, at: Date.now(), url: message.url });
          bot.db.saveMember();
        }

        const key = `${message.channelId}:${user.id}`;
        if (Date.now() - (announced.get(key) || 0) < ANNOUNCE_COOLDOWN_MS) continue;
        announced.set(key, Date.now());
        notes.push(`**${user.username}** is away: ${afk.reason} (since ${relative(afk.since)})`);
      }

      if (!notes.length) return false;

      const notice = await message
        .reply({ content: notes.join('\n'), allowedMentions: { parse: [] } })
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 20_000);
      return true;
    },

    /** Everyone currently away in a guild. */
    list(guildId) {
      return bot.db
        .members(guildId)
        .filter(([, record]) => record.afk)
        .map(([userId, record]) => ({ userId, ...record.afk }))
        .sort((a, b) => a.since - b.since);
    },

    shutdown() {
      clearInterval(sweeper);
    },
  };

  return api;
}

module.exports = { name: 'afk', init };
