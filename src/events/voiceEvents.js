'use strict';

/**
 * Voice tracking: logging plus optional voice XP.
 *
 * Voice XP is awarded on leave, computed from how long the member was actually
 * connected, rather than by a ticking timer. A timer that runs every minute for
 * every member in every voice channel is a lot of wasted work on a large server,
 * and it awards XP to somebody who joined, muted themselves and went to bed.
 *
 * The rules applied here mirror what people expect from "active in voice":
 *   - a member alone in a channel earns nothing
 *   - a self-deafened member earns nothing, because they are not present
 *   - a server-muted member still earns, since that is a moderation state
 */

const MIN_SESSION_MS = 60_000;
const MAX_SESSION_MS = 12 * 60 * 60_000;

module.exports = {
  name: 'voiceStateUpdate',

  async execute(bot, before, after) {
    const member = after.member || before.member;
    if (!member || member.user.bot) return;
    const guild = member.guild;

    // ---------- session accounting ----------
    // Held in memory: a voice session that spans a restart is not worth a disk
    // write per member per join.
    bot.voiceSessions ??= new Map();
    const key = `${guild.id}:${member.id}`;

    const joined = !before.channelId && after.channelId;
    const left = before.channelId && !after.channelId;
    const moved = before.channelId && after.channelId && before.channelId !== after.channelId;

    if (joined || moved) {
      bot.voiceSessions.set(key, { since: Date.now(), channelId: after.channelId });
    }

    if (left || moved) {
      const session = bot.voiceSessions.get(key);
      if (left) bot.voiceSessions.delete(key);

      if (session) {
        const elapsed = Math.min(MAX_SESSION_MS, Date.now() - session.since);
        if (elapsed >= MIN_SESSION_MS) {
          const minutes = Math.floor(elapsed / 60_000);

          // Only count time where the channel had someone else in it.
          const channel = guild.channels.cache.get(session.channelId);
          const hadCompany = (channel?.members?.size || 0) > (left ? 0 : 1);

          if (minutes > 0 && hadCompany && !before.selfDeaf) {
            try {
              await bot.features.leveling?.awardVoice(member, minutes);
            } catch (e) {
              bot.log.error('voice XP failed:', e);
            }
          } else if (minutes > 0) {
            // Time is still recorded for /profile even when it earns nothing.
            const record = bot.db.member(guild.id, member.id);
            record.voiceMinutes += minutes;
            bot.db.saveMember();
          }
        }
      }
    }

    // ---------- logging ----------
    const logging = bot.features.logging;
    if (!logging) return;

    if (joined) {
      await logging.post(guild, 'voiceJoin', logging.voiceEvent(member, `Joined <#${after.channelId}>`));
    } else if (left) {
      await logging.post(guild, 'voiceLeave', logging.voiceEvent(member, `Left <#${before.channelId}>`));
    } else if (moved) {
      await logging.post(
        guild,
        'voiceMove',
        logging.voiceEvent(member, `Moved from <#${before.channelId}> to <#${after.channelId}>`),
      );
    }
  },
};
