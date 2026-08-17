'use strict';

const rng = require('../util/random');
const embeds = require('../util/embeds');
const { template, progressBar, number } = require('../util/text');

/**
 * Message and voice XP levelling.
 *
 * Curve: the cost of level N is 5N² + 50N + 100, the same shape most servers
 * are used to. It starts gentle enough that a new member sees progress in their
 * first conversation and steepens fast enough that level 50 stays meaningful.
 *
 * XP is only awarded once per cooldown window (60s by default) so a member
 * cannot farm it by spamming single characters, and the check happens before
 * anything is written, which keeps the hot path on messageCreate cheap.
 */

/** XP required to go from `level` to `level + 1`. */
function xpToNext(level) {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP needed to reach `level` from zero. */
function totalXpFor(level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

/** Level implied by a total XP amount. */
function levelFromXp(xp) {
  let level = 0;
  let remaining = Number(xp) || 0;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
    if (level > 1000) break; // defensive: never loop forever on corrupt data
  }
  return level;
}

/** Progress inside the current level: { current, needed, ratio }. */
function progress(xp) {
  const level = levelFromXp(xp);
  const consumed = totalXpFor(level);
  return {
    level,
    current: xp - consumed,
    needed: xpToNext(level),
    ratio: (xp - consumed) / xpToNext(level),
  };
}

function init(bot) {
  const log = bot.log.child('leveling');

  /** Roles a member should hold at a given level, honouring stackRewards. */
  function rewardsFor(settings, level) {
    const rewards = settings.leveling.rewards || {};
    const levels = Object.keys(rewards)
      .map(Number)
      .filter((l) => !Number.isNaN(l))
      .sort((a, b) => a - b);

    if (settings.leveling.stackRewards) {
      return levels.filter((l) => l <= level).flatMap((l) => rewards[String(l)] || []);
    }
    // Non-stacking: only the highest threshold the member has passed.
    const highest = levels.filter((l) => l <= level).pop();
    return highest === undefined ? [] : rewards[String(highest)] || [];
  }

  /** Applies reward roles, removing superseded ones when stacking is off. */
  async function syncRewardRoles(member, settings, level) {
    const wanted = new Set(rewardsFor(settings, level));
    if (!wanted.size && settings.leveling.stackRewards) return [];

    const all = new Set(
      Object.values(settings.leveling.rewards || {}).flat(),
    );
    const added = [];

    for (const roleId of wanted) {
      if (member.roles.cache.has(roleId)) continue;
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue;
      const me = member.guild.members.me;
      if (role.position >= me.roles.highest.position || role.managed) {
        log.debug(`cannot grant level role ${role.name}: it is above my highest role`);
        continue;
      }
      await member.roles.add(role, 'Level reward').catch(() => {});
      added.push(role);
    }

    if (!settings.leveling.stackRewards) {
      for (const roleId of all) {
        if (wanted.has(roleId) || !member.roles.cache.has(roleId)) continue;
        await member.roles.remove(roleId, 'Superseded level reward').catch(() => {});
      }
    }
    return added;
  }

  /** XP multiplier from role bonuses and an active booster item. */
  function multiplierFor(member, settings, record) {
    let multiplier = 1;
    for (const [roleId, value] of Object.entries(settings.leveling.multipliers || {})) {
      if (member.roles.cache.has(roleId)) multiplier = Math.max(multiplier, Number(value) || 1);
    }
    if (record.xpBoostUntil && record.xpBoostUntil > Date.now()) multiplier *= 2;
    return multiplier;
  }

  const api = {
    xpToNext,
    totalXpFor,
    levelFromXp,
    progress,
    rewardsFor,

    /**
     * Awards XP for a message. Returns the new level when the member levelled
     * up, otherwise null.
     */
    async onMessage(message) {
      const settings = bot.db.settings(message.guildId);
      if (!settings.leveling.enabled) return null;
      if (!bot.config.features.leveling) return null;
      if (settings.leveling.noXpChannels.includes(message.channelId)) return null;
      if (message.member?.roles.cache.some((r) => settings.leveling.noXpRoles.includes(r.id))) return null;

      const record = bot.db.member(message.guildId, message.author.id);
      record.messages++;

      const cooldownMs = (settings.leveling.cooldownSeconds || 60) * 1000;
      if (Date.now() - (record.lastXpAt || 0) < cooldownMs) {
        bot.db.saveMember();
        return null;
      }

      const before = levelFromXp(record.xp);
      const gain = Math.round(rng.inRange(settings.leveling.xpPerMessage, [15, 25]) * multiplierFor(message.member, settings, record));
      record.xp += gain;
      record.lastXpAt = Date.now();
      const after = levelFromXp(record.xp);
      record.level = after;
      bot.db.saveMember();

      if (after <= before) return null;

      await api.announceLevelUp(message, after, settings);
      return after;
    },

    /** Posts the level-up message and applies reward roles. */
    async announceLevelUp(message, level, settings) {
      const roles = await syncRewardRoles(message.member, settings, level).catch(() => []);

      if (!settings.leveling.announce) return;

      const text = template(settings.leveling.announceMessage || 'GG {user}, you reached level **{level}**!', {
        user: `<@${message.author.id}>`,
        tag: message.author.tag,
        username: message.author.username,
        level,
        server: message.guild.name,
      });

      const embed = embeds.base('Level up', text).setColor(embeds.theme.success);
      if (roles.length) {
        embed.addFields({ name: 'Unlocked', value: roles.map((r) => `<@&${r.id}>`).join(' ') });
      }

      const targetId = settings.leveling.announceChannelId;
      if (targetId) {
        await bot.sendTo(message.guild, targetId, { embeds: [embed] });
      } else {
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
    },

    /** Voice XP, awarded per minute by the voice tracker. */
    async awardVoice(member, minutes) {
      const settings = bot.db.settings(member.guild.id);
      if (!settings.leveling.enabled || !settings.leveling.voiceXp) return null;

      const record = bot.db.member(member.guild.id, member.id);
      const before = levelFromXp(record.xp);
      record.voiceMinutes += minutes;
      record.xp += (settings.leveling.voiceXpPerMinute || 5) * minutes;
      const after = levelFromXp(record.xp);
      record.level = after;
      bot.db.saveMember();

      if (after > before) await syncRewardRoles(member, settings, after).catch(() => {});
      return after > before ? after : null;
    },

    /** Directly sets XP, used by the admin subcommands. */
    setXp(guildId, userId, xp) {
      const record = bot.db.member(guildId, userId);
      record.xp = Math.max(0, Math.floor(xp));
      record.level = levelFromXp(record.xp);
      bot.db.saveMember();
      return record;
    },

    addXp(guildId, userId, amount) {
      const record = bot.db.member(guildId, userId);
      return api.setXp(guildId, userId, record.xp + amount);
    },

    /** Ranked list of members by XP. */
    leaderboard(guildId, limit = 100) {
      return bot.db.leaderboard(guildId, (r) => r.xp, limit);
    },

    /** A member's position in the XP leaderboard, 1-based, or 0 when unranked. */
    rankOf(guildId, userId) {
      const board = api.leaderboard(guildId, 10_000);
      const idx = board.findIndex((e) => e.userId === userId);
      return idx === -1 ? 0 : idx + 1;
    },

    /** Text rank card, used by /rank. */
    renderCard(user, record, rank, total) {
      const p = progress(record.xp);
      const bar = progressBar(p.ratio, 22);
      return embeds
        .base(`${user.username}'s rank`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setDescription(
          [
            `**Level ${p.level}**  •  ${rank ? `rank #${rank} of ${total}` : 'unranked'}`,
            '',
            `\`${bar}\``,
            `${number(p.current)} / ${number(p.needed)} XP to level ${p.level + 1}`,
            `${number(record.xp)} XP total  •  ${number(record.messages)} messages`,
            record.voiceMinutes ? `${number(record.voiceMinutes)} minutes in voice` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        );
    },
  };

  return api;
}

module.exports = { name: 'leveling', init, xpToNext, totalXpFor, levelFromXp, progress };
