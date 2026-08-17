'use strict';

/**
 * Cooldowns and rate limiting.
 *
 * Two separate concerns live here:
 *
 *   1. Per-command cooldowns. Cosmetic commands are cheap, but /clear or a game
 *      that posts a board are not - a user holding enter on one of those can
 *      push the bot into Discord's own rate limiter, which then delays every
 *      other user in the server.
 *   2. A global sliding-window guard. If any single user exceeds a burst budget
 *      across all commands, they are ignored for a short while. This is the
 *      cheap defence against someone scripting a command loop.
 *
 * Entries are kept in a Map and swept periodically; without the sweep a raid
 * would leave one Map entry per attacker forever.
 */
class CooldownManager {
  constructor({ log } = {}) {
    this.log = log;
    /** key -> expiry epoch ms */
    this.entries = new Map();
    /** userId -> number[] of recent command timestamps */
    this.windows = new Map();
    /** userId -> epoch ms until which the user is ignored entirely */
    this.penalties = new Map();

    this.burstLimit = 8; // commands ...
    this.burstWindowMs = 10_000; // ... per this window
    this.penaltyMs = 20_000; // ... before this cool-off

    this.sweeper = setInterval(() => this.sweep(), 60_000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  /**
   * Checks and consumes a command cooldown.
   * @returns {number} remaining ms, or 0 when the command may run
   */
  check(userId, commandName, seconds) {
    if (!seconds || seconds <= 0) return 0;
    const key = `${userId}:${commandName}`;
    const until = this.entries.get(key) || 0;
    const now = Date.now();
    if (until > now) return until - now;
    this.entries.set(key, now + seconds * 1000);
    return 0;
  }

  /** Reads a cooldown without consuming it. */
  peek(userId, commandName) {
    const until = this.entries.get(`${userId}:${commandName}`) || 0;
    return Math.max(0, until - Date.now());
  }

  /** Clears one cooldown, e.g. when a command bailed out before doing work. */
  clear(userId, commandName) {
    this.entries.delete(`${userId}:${commandName}`);
  }

  /** Clears every cooldown for a user. Used by owner tooling. */
  clearUser(userId) {
    for (const key of this.entries.keys()) if (key.startsWith(`${userId}:`)) this.entries.delete(key);
    this.windows.delete(userId);
    this.penalties.delete(userId);
  }

  /**
   * Sliding-window burst guard.
   * @returns {number} remaining penalty ms, or 0 when the user may proceed
   */
  guard(userId) {
    const now = Date.now();
    const penalty = this.penalties.get(userId) || 0;
    if (penalty > now) return penalty - now;

    const hits = (this.windows.get(userId) || []).filter((t) => now - t < this.burstWindowMs);
    hits.push(now);
    this.windows.set(userId, hits);

    if (hits.length > this.burstLimit) {
      this.penalties.set(userId, now + this.penaltyMs);
      this.windows.delete(userId);
      this.log?.warn(`rate limiting user ${userId}: ${hits.length} commands in ${this.burstWindowMs}ms`);
      return this.penaltyMs;
    }
    return 0;
  }

  /** Drops expired entries so a raid cannot grow the maps without bound. */
  sweep() {
    const now = Date.now();
    for (const [key, until] of this.entries) if (until <= now) this.entries.delete(key);
    for (const [key, until] of this.penalties) if (until <= now) this.penalties.delete(key);
    for (const [key, hits] of this.windows) {
      const live = hits.filter((t) => now - t < this.burstWindowMs);
      if (live.length) this.windows.set(key, live);
      else this.windows.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweeper);
  }

  stats() {
    return {
      cooldowns: this.entries.size,
      tracked: this.windows.size,
      penalised: this.penalties.size,
    };
  }
}

module.exports = { CooldownManager };
