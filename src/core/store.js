'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * JsonStore - a small, crash-safe JSON document store.
 *
 * Why not a real database? The bot must run on hosting panels where installing
 * native modules (better-sqlite3 and friends) fails or is not allowed at all.
 * A JSON file per collection keeps the dependency list at exactly one package
 * while still being safe if it is written carefully:
 *
 *   - writes go to a temporary file and are then renamed over the target, so a
 *     crash mid-write can never leave a truncated file behind (rename is atomic
 *     on both POSIX and NTFS)
 *   - writes are debounced and coalesced, so a busy chat channel awarding XP on
 *     every message does not translate to one disk write per message
 *   - a corrupt file is moved aside rather than deleted, and the store starts
 *     empty instead of refusing to boot
 *   - a rolling set of backups is kept so a bad migration is recoverable
 *
 * The trade-off is that the whole collection lives in memory. For a bot serving
 * a few thousand members that is a few megabytes, which is fine.
 */
class JsonStore {
  /**
   * @param {string} file absolute path of the JSON file
   * @param {object} [opts]
   * @param {*} [opts.defaults] value used when the file does not exist yet
   * @param {number} [opts.saveIntervalMs] debounce window for writes
   * @param {number} [opts.backupCount] how many rotating backups to keep
   * @param {import('./logger').Logger} [opts.log]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.tmpFile = `${file}.tmp`;
    this.defaults = opts.defaults ?? {};
    this.saveIntervalMs = opts.saveIntervalMs ?? 15_000;
    this.backupCount = opts.backupCount ?? 3;
    this.log = opts.log || null;

    this.data = null;
    this.dirty = false;
    this.timer = null;
    this.writes = 0;
    this.reads = 0;
    this.lastSavedAt = 0;
    this.loadError = null;

    this.load();
  }

  // ---------- disk ----------

  /** Reads the file into memory. Never throws: a broken file becomes an empty store. */
  load() {
    this.reads++;
    try {
      if (!fs.existsSync(this.file)) {
        this.data = structuredClone(this.defaults);
        return;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.trim()) {
        this.data = structuredClone(this.defaults);
        return;
      }
      this.data = JSON.parse(raw);
    } catch (e) {
      this.loadError = e;
      this.log?.error(`store ${path.basename(this.file)} is unreadable: ${e.message}`);
      // Preserve the damaged file for forensics instead of silently discarding
      // what may be the only copy of a server's economy.
      try {
        const dead = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, dead);
        this.log?.warn(`moved the damaged file to ${path.basename(dead)}; starting empty`);
      } catch {
        /* the rename is best effort - starting empty matters more */
      }
      this.data = structuredClone(this.defaults);
    }
  }

  /** Marks the store dirty and schedules a debounced flush. */
  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.saveIntervalMs);
    // A pending save must never be the reason the process stays alive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Writes the current state to disk immediately.
   * @param {boolean} [force] write even when nothing changed
   * @returns {boolean} whether a write happened
   */
  flush(force = false) {
    if (!this.dirty && !force) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const json = JSON.stringify(this.data, null, 0);
      // tmp + rename keeps the target file either fully old or fully new.
      fs.writeFileSync(this.tmpFile, json, 'utf8');
      fs.renameSync(this.tmpFile, this.file);
      this.dirty = false;
      this.writes++;
      this.lastSavedAt = Date.now();
      return true;
    } catch (e) {
      this.log?.error(`failed to write ${path.basename(this.file)}: ${e.message}`);
      return false;
    }
  }

  /**
   * Rotates a numbered backup set: file.bak.1 is the newest.
   * Called on a timer by the bot, not on every write.
   */
  backup() {
    if (this.backupCount <= 0) return false;
    try {
      if (!fs.existsSync(this.file)) return false;
      for (let i = this.backupCount - 1; i >= 1; i--) {
        const from = `${this.file}.bak.${i}`;
        const to = `${this.file}.bak.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.copyFileSync(this.file, `${this.file}.bak.1`);
      return true;
    } catch (e) {
      this.log?.warn(`backup of ${path.basename(this.file)} failed: ${e.message}`);
      return false;
    }
  }

  // ---------- access ----------

  /**
   * Reads a dotted path, e.g. get('123.456.coins', 0).
   * Returns the fallback when any segment is missing.
   */
  get(pathStr, fallback = undefined) {
    const parts = String(pathStr).split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur === null || typeof cur !== 'object' || !(p in cur)) return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  /** Writes a dotted path, creating intermediate objects as needed. */
  set(pathStr, value) {
    const parts = String(pathStr).split('.');
    const last = parts.pop();
    let cur = this.data;
    for (const p of parts) {
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[last] = value;
    this.touch();
    return value;
  }

  /** Deletes a dotted path. Returns true when something was removed. */
  delete(pathStr) {
    const parts = String(pathStr).split('.');
    const last = parts.pop();
    let cur = this.data;
    for (const p of parts) {
      if (typeof cur[p] !== 'object' || cur[p] === null) return false;
      cur = cur[p];
    }
    if (!(last in cur)) return false;
    delete cur[last];
    this.touch();
    return true;
  }

  /** True when the dotted path resolves to something other than undefined. */
  has(pathStr) {
    return this.get(pathStr, Symbol.for('missing')) !== Symbol.for('missing');
  }

  /**
   * Returns the object at `pathStr`, creating it from `seed` when absent.
   * The returned object is live: mutate it and call touch().
   */
  ensure(pathStr, seed = {}) {
    const existing = this.get(pathStr);
    if (existing && typeof existing === 'object') return existing;
    const created = structuredClone(seed);
    this.set(pathStr, created);
    return created;
  }

  /** Adds a number to a dotted path, treating a missing value as 0. */
  add(pathStr, amount) {
    const next = (Number(this.get(pathStr, 0)) || 0) + amount;
    this.set(pathStr, next);
    return next;
  }

  /** Pushes onto an array at a dotted path, creating the array when missing. */
  push(pathStr, value, { max = 0 } = {}) {
    const arr = this.get(pathStr);
    const list = Array.isArray(arr) ? arr : [];
    list.push(value);
    if (max > 0 && list.length > max) list.splice(0, list.length - max);
    this.set(pathStr, list);
    return list;
  }

  /** Top-level keys of the store. */
  keys() {
    return Object.keys(this.data || {});
  }

  /** Number of top-level entries. */
  get size() {
    return this.keys().length;
  }

  /** Replaces the whole document. Used by imports and migrations. */
  replace(data) {
    this.data = data;
    this.touch();
  }

  /** Stops the debounce timer and performs a final synchronous write. */
  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flush();
  }

  /** Diagnostic snapshot used by /stats storage. */
  stats() {
    let bytes = 0;
    try {
      bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch {
      /* size is cosmetic */
    }
    return {
      file: path.basename(this.file),
      entries: this.size,
      bytes,
      writes: this.writes,
      dirty: this.dirty,
      lastSavedAt: this.lastSavedAt,
      broken: Boolean(this.loadError),
    };
  }
}

module.exports = { JsonStore };
