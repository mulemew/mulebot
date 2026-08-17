'use strict';

const cache = require('../core/cache');
const { isEmptyMember } = require('../core/db');
const { number } = require('../util/text');

/**
 * Periodic housekeeping and the memory watchdog.
 *
 * Everything else in this bot bounds its own growth at the point of writing -
 * cases cap at 5,000 per guild, the snipe buffer keeps 5 per channel, game
 * sessions expire. Four things could not be bounded at write time and are
 * cleaned up here instead:
 *
 *   pollData          a closed poll is dead weight, but the message may still
 *                     be scrolled to for weeks, so it cannot be dropped on close
 *   suggestionData    same reasoning for resolved suggestions
 *   starboard entries the source→mirror mapping exists to prevent duplicate
 *                     posts; after months a message will not gain new stars
 *   member records    created on read, so a leaderboard render can add a row
 *                     per member that holds nothing at all
 *
 * Without this pass, a long-lived bot on a busy server grows its JSON files
 * forever, and since every store is held in memory that is also a slow leak.
 */

const MB = 1024 * 1024;

function init(bot) {
  const log = bot.log.child('maintenance');
  const profile = bot.cacheProfile?.meta || cache.PROFILES.balanced;

  /** Ages, in days, past which each kind of record is dropped. */
  const AGE = {
    poll: 30,
    suggestion: 90,
    starboard: 120,
  };

  const api = {
    lastRun: 0,
    lastResult: null,

    /**
     * Runs one housekeeping pass.
     * @param {{ dryRun?: boolean }} [opts]
     */
    run({ dryRun = false } = {}) {
      const started = Date.now();
      const removed = { polls: 0, suggestions: 0, starboard: 0, members: 0, tasks: 0, guilds: 0 };
      const now = Date.now();

      // ---------- closed polls and resolved suggestions ----------
      for (const guildId of bot.db.stores.guilds.keys()) {
        const guild = bot.db.stores.guilds.get(guildId, {});

        for (const [messageId, poll] of Object.entries(guild.pollData || {})) {
          const age = now - (poll.closedAt || poll.endsAt || poll.createdAt || 0);
          if (!poll.closed && poll.endsAt && poll.endsAt > now) continue;
          if (age < AGE.poll * 86_400_000) continue;
          if (!dryRun) bot.db.stores.guilds.delete(`${guildId}.pollData.${messageId}`);
          removed.polls++;
        }

        for (const [messageId, suggestion] of Object.entries(guild.suggestionData || {})) {
          if (suggestion.status === 'open') continue;
          const age = now - (suggestion.resolvedAt || suggestion.createdAt || 0);
          if (age < AGE.suggestion * 86_400_000) continue;
          if (!dryRun) bot.db.stores.guilds.delete(`${guildId}.suggestionData.${messageId}`);
          removed.suggestions++;
        }
      }

      // ---------- starboard mappings ----------
      for (const guildId of bot.db.stores.starboard.keys()) {
        const entries = bot.db.stores.starboard.get(guildId, {});
        for (const [messageId, entry] of Object.entries(entries)) {
          if (now - (entry.at || 0) < AGE.starboard * 86_400_000) continue;
          if (!dryRun) bot.db.stores.starboard.delete(`${guildId}.${messageId}`);
          removed.starboard++;
        }
      }

      // ---------- empty and long-idle member records ----------
      const idleDays = profile.memberIdleDays || 0;
      for (const guildId of bot.db.stores.members.keys()) {
        const members = bot.db.stores.members.get(guildId, {});
        for (const [userId, record] of Object.entries(members)) {
          let drop = isEmptyMember(record);

          // On a memory-constrained profile, also drop records whose owner has
          // been inactive for a long time and who holds nothing but XP - the
          // leaderboard loses a stale row, the host gains headroom.
          if (!drop && idleDays > 0) {
            const lastSeen = Math.max(record.lastXpAt || 0, record.lastDaily || 0, record.lastWork || 0);
            const idle = lastSeen && now - lastSeen > idleDays * 86_400_000;
            const disposable = !record.coins && !record.bank && !Object.keys(record.inventory || {}).length;
            if (idle && disposable && record.xp < 100) drop = true;
          }

          if (!drop) continue;
          if (!dryRun) bot.db.deleteMember(guildId, userId);
          removed.members++;
        }
      }

      // ---------- scheduler queue ----------
      // A task parked because its handler vanished (an unloaded plugin) is kept
      // deliberately, but not forever.
      const stale = bot.scheduler.cancelWhere(
        (t) => t.parked && now - (t.createdAt || 0) > 30 * 86_400_000,
      );
      removed.tasks = dryRun ? 0 : stale;

      // ---------- giveaways ----------
      if (!dryRun) bot.features.giveaways?.prune?.();

      const took = Date.now() - started;
      const total = Object.values(removed).reduce((a, b) => a + b, 0);

      if (!dryRun) {
        bot.db.flushAll();
        api.lastRun = Date.now();
        api.lastResult = { ...removed, took, total };
      }

      if (total) {
        log.info(
          `pruned ${total} record(s) in ${took}ms — ` +
            Object.entries(removed)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k}: ${n}`)
              .join(', '),
        );
      } else {
        log.debug(`nothing to prune (${took}ms)`);
      }

      return { ...removed, took, total, dryRun };
    },

    /** Current memory picture, used by /stats and the watchdog. */
    memory() {
      const usage = process.memoryUsage();
      const limitMb = cache.containerMemoryLimitMb();
      return {
        rssMb: Math.round((usage.rss / MB) * 10) / 10,
        heapUsedMb: Math.round((usage.heapUsed / MB) * 10) / 10,
        heapTotalMb: Math.round((usage.heapTotal / MB) * 10) / 10,
        externalMb: Math.round((usage.external / MB) * 10) / 10,
        limitMb,
        percentOfLimit: limitMb ? Math.round((usage.rss / MB / limitMb) * 100) : null,
        profile: bot.cacheProfile?.profile || 'unknown',
        caches: cache.snapshot(bot.client),
      };
    },
  };

  // ---------- scheduled pass ----------
  bot.scheduler.register('maintenance', () => api.run());
  if (!bot.scheduler.find({ type: 'maintenance' }).length) {
    const everyMs = (profile.maintenanceHours || 12) * 3_600_000;
    // First pass an hour after boot, so a restart loop cannot turn housekeeping
    // into a busy loop of full-store scans.
    bot.scheduler.scheduleIn('maintenance', 3_600_000, {}, { repeatMs: everyMs });
    log.debug(`housekeeping scheduled every ${profile.maintenanceHours}h`);
  }

  // ---------- memory watchdog ----------
  // Only meaningful when a limit is known. On a 256 MB container the OOM killer
  // gives no warning at all, so the point is to say something *before* that.
  const limitMb = cache.containerMemoryLimitMb();
  let warned = 0;

  const watchdog = setInterval(() => {
    const rssMb = process.memoryUsage().rss / MB;
    const known = limitMb || Math.round(require('node:os').totalmem() / MB);
    const percent = (rssMb / known) * 100;

    if (percent < 80) {
      warned = 0;
      return;
    }
    // At most one warning per 30 minutes, so a tight host does not spam the log.
    if (Date.now() - warned < 30 * 60_000) return;
    warned = Date.now();

    const caches = cache.snapshot(bot.client);
    log.warn(
      `memory at ${Math.round(rssMb)} MB of ~${known} MB (${Math.round(percent)}%). ` +
        `Caches: ${caches.messages || 0} messages, ${caches.members || 0} members, ${caches.users || 0} users.`,
    );
    if (bot.cacheProfile?.profile !== 'low') {
      log.warn('Set MEMORY_PROFILE=low to cap the caches harder, then restart.');
    }
    if (percent > 92) {
      log.warn('Running a housekeeping pass early.');
      api.run();
    }
  }, 60_000);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  api.shutdown = () => clearInterval(watchdog);

  void number;
  return api;
}

module.exports = { name: 'maintenance', init };
