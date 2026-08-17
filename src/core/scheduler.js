'use strict';

/**
 * Persistent scheduler.
 *
 * A bare setTimeout dies with the process, which means a restart silently drops
 * every pending reminder, temporary ban and giveaway. This scheduler stores its
 * queue in tasks.json and re-arms it on boot, so a panel restart costs nothing.
 *
 * Design notes:
 *   - a single coarse tick (default 5s) drives everything, instead of one timer
 *     per task. Thousands of pending reminders then cost one timer, not thousands.
 *   - tasks overdue at boot run immediately, in order, rather than being lost.
 *   - handlers are registered by type name. An unknown type (a task written by a
 *     newer version, then downgraded) is kept but skipped, never dropped.
 *   - a task that throws is retried a few times with backoff, then parked with
 *     an error so it can be inspected instead of vanishing.
 */
class Scheduler {
  /**
   * @param {{ store: import('./store').JsonStore, log: object, tickMs?: number }} opts
   */
  constructor({ store, log, tickMs = 5_000 }) {
    this.store = store;
    this.log = log;
    this.tickMs = tickMs;
    this.handlers = new Map();
    this.timer = null;
    this.running = false;
    this.ran = 0;
    this.failed = 0;
  }

  /** All persisted tasks. */
  get tasks() {
    const t = this.store.get('tasks', []);
    return Array.isArray(t) ? t : [];
  }

  set tasks(list) {
    this.store.set('tasks', list);
  }

  /**
   * Registers the function that executes a task type.
   * @param {string} type
   * @param {(task: object) => Promise<void>|void} fn
   */
  register(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  /**
   * Removes a handler. Queued tasks of that type are kept and parked rather
   * than deleted, so unloading a plugin does not silently discard the work it
   * had scheduled - reloading it picks the tasks back up.
   */
  unregister(type) {
    return this.handlers.delete(type);
  }

  /** Clears the parked flag on tasks whose handler has just come back. */
  revive(type) {
    let revived = 0;
    const list = this.tasks;
    for (const task of list) {
      if (task.type === type && task.parked) {
        delete task.parked;
        delete task.error;
        revived++;
      }
    }
    if (revived) this.store.touch();
    return revived;
  }

  /**
   * Queues a task.
   * @param {string} type registered handler name
   * @param {number} runAt absolute epoch ms
   * @param {object} [data] payload handed back to the handler
   * @param {{ repeatMs?: number, guildId?: string, userId?: string }} [opts]
   * @returns {object} the stored task
   */
  schedule(type, runAt, data = {}, opts = {}) {
    const seq = (this.store.get('seq', 0) || 0) + 1;
    this.store.set('seq', seq);
    const task = {
      id: seq,
      type,
      runAt: Math.max(Date.now(), Number(runAt) || Date.now()),
      data,
      guildId: opts.guildId || data.guildId || null,
      userId: opts.userId || data.userId || null,
      repeatMs: opts.repeatMs || 0,
      attempts: 0,
      createdAt: Date.now(),
    };
    const list = this.tasks;
    list.push(task);
    this.tasks = list;
    return task;
  }

  /** Convenience wrapper: schedule relative to now. */
  scheduleIn(type, delayMs, data = {}, opts = {}) {
    return this.schedule(type, Date.now() + delayMs, data, opts);
  }

  /** Removes a task by id. */
  cancel(id) {
    const list = this.tasks;
    const idx = list.findIndex((t) => t.id === Number(id));
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.tasks = list;
    return true;
  }

  /** Removes every task matching a predicate; returns how many were removed. */
  cancelWhere(predicate) {
    const list = this.tasks;
    const keep = list.filter((t) => !predicate(t));
    const removed = list.length - keep.length;
    if (removed) this.tasks = keep;
    return removed;
  }

  /** Tasks matching a filter, sorted by due time. */
  find({ type = null, guildId = null, userId = null } = {}) {
    return this.tasks
      .filter(
        (t) =>
          (!type || t.type === type) &&
          (!guildId || t.guildId === guildId) &&
          (!userId || t.userId === userId),
      )
      .sort((a, b) => a.runAt - b.runAt);
  }

  /** Starts the tick loop. Safe to call twice. */
  start() {
    if (this.timer) return;
    const due = this.tasks.filter((t) => t.runAt <= Date.now()).length;
    if (due) this.log?.info(`${due} scheduled task(s) were due while the bot was offline, running them now`);
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Run one tick straight away so overdue work does not wait for the interval.
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Executes everything that is due. Never runs concurrently with itself. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const list = this.tasks;
      const due = list.filter((t) => t.runAt <= now && !t.parked);
      if (!due.length) return;

      // Oldest first, so a burst of overdue tasks fires in the order it was queued.
      due.sort((a, b) => a.runAt - b.runAt);

      for (const task of due) {
        const handler = this.handlers.get(task.type);
        if (!handler) {
          // Written by another version. Keep it but stop retrying every tick.
          this.log?.warn(`no handler for scheduled task type "${task.type}" (id ${task.id}), parking it`);
          task.parked = true;
          task.error = 'unknown task type';
          continue;
        }

        try {
          await handler(task);
          this.ran++;
          if (task.repeatMs > 0) {
            // Re-arm relative to the intended time so drift does not accumulate.
            task.runAt = Math.max(Date.now(), task.runAt + task.repeatMs);
            task.attempts = 0;
          } else {
            this.cancel(task.id);
          }
        } catch (e) {
          this.failed++;
          task.attempts = (task.attempts || 0) + 1;
          task.error = e.message;
          if (task.attempts >= 3) {
            this.log?.error(`scheduled task ${task.id} (${task.type}) failed ${task.attempts}x, dropping it: ${e.message}`);
            this.cancel(task.id);
          } else {
            // Exponential-ish backoff: 30s, then 2 minutes.
            task.runAt = Date.now() + 30_000 * task.attempts * task.attempts;
            this.log?.warn(`scheduled task ${task.id} (${task.type}) failed, retry ${task.attempts}/3: ${e.message}`);
          }
        }
      }
      this.store.touch();
    } finally {
      this.running = false;
    }
  }

  /** Snapshot for /stats. */
  stats() {
    const list = this.tasks;
    const byType = {};
    for (const t of list) byType[t.type] = (byType[t.type] || 0) + 1;
    return {
      pending: list.length,
      parked: list.filter((t) => t.parked).length,
      ran: this.ran,
      failed: this.failed,
      byType,
      next: list.length ? Math.min(...list.map((t) => t.runAt)) : 0,
    };
  }
}

module.exports = { Scheduler };
