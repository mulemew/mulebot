'use strict';

/**
 * Logger
 *
 * Everything is written to stdout. Hosting panels (Pterodactyl, Pelican,
 * FeatherPanel) stream stdout to their web console and frequently discard
 * stderr, so a diagnostic on stderr is a diagnostic nobody reads.
 *
 * Extras over a bare console.log:
 *   - levels with an env-configurable threshold
 *   - a scope tag so "[automod]" and "[economy]" lines are greppable
 *   - a ring buffer of recent lines, exposed through /stats logs for admins
 *   - ANSI colour only when the stream is a TTY, so panel logs stay clean
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 99 };

const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[97m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

/** Ring buffer of recent log lines, newest last. */
class RingBuffer {
  constructor(size = 500) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }

  /** Returns the last `n` entries, optionally filtered by minimum level. */
  tail(n = 50, minLevel = 0) {
    return this.items.filter((e) => LEVELS[e.level] >= minLevel).slice(-n);
  }

  clear() {
    this.items.length = 0;
  }
}

const buffer = new RingBuffer(500);

/**
 * Optional size-capped log file.
 *
 * stdout is the primary sink and stays that way, because hosting panels read
 * it. But `node index.js > bot.log` grows without limit, and on a small VPS a
 * forgotten log file is a realistic way to run out of disk. When a file is
 * configured, this writes to it with size-based rotation and a fixed number of
 * generations, so total log usage has a hard ceiling of
 * maxBytes * (keep + 1) - roughly 5 MB by default.
 */
class RotatingFile {
  constructor({ file, maxBytes = 1024 * 1024, keep = 4 }) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.size = 0;
    this.stream = null;
    this.failed = false;
    this.open();
  }

  open() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      // Open the descriptor synchronously and hand it to the stream. Letting
      // createWriteStream open it asynchronously means the file does not exist
      // yet when open() returns, so a rotation immediately followed by a read
      // sees no live log file - and this.size starts from a stale stat.
      const fd = fs.openSync(this.file, 'a');
      this.size = fs.fstatSync(fd).size;
      this.stream = fs.createWriteStream(null, { fd, autoClose: true });
      this.stream.on('error', (e) => {
        // A disk that filled up must not take the bot down with it.
        this.failed = true;
        process.stdout.write(`[logger] file logging disabled: ${e.message}\n`);
      });
    } catch (e) {
      this.failed = true;
      process.stdout.write(`[logger] could not open ${this.file}: ${e.message}\n`);
    }
  }

  rotate() {
    try {
      this.stream?.end();
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
      const oldest = `${this.file}.${this.keep + 1}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    } catch (e) {
      process.stdout.write(`[logger] rotation failed: ${e.message}\n`);
    }
    this.open();
  }

  write(line) {
    if (this.failed || !this.stream) return;
    const bytes = Buffer.byteLength(line);
    if (this.size + bytes > this.maxBytes) this.rotate();
    this.size += bytes;
    this.stream.write(line);
  }

  close() {
    try {
      this.stream?.end();
    } catch {
      /* shutting down anyway */
    }
  }

  stats() {
    return { file: this.file, bytes: this.size, maxBytes: this.maxBytes, keep: this.keep, failed: this.failed };
  }
}

/** The single process-wide file sink, created only when configured. */
let fileSink = null;

function configureFile({ file, maxBytes, keep } = {}) {
  if (fileSink) fileSink.close();
  fileSink = file ? new RotatingFile({ file, maxBytes, keep }) : null;
  return fileSink;
}

function fileStats() {
  return fileSink ? fileSink.stats() : null;
}

/** Formats a Date as HH:MM:SS in the host timezone. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Renders one argument. Errors become their stack (naive joining would turn
 * them into a useless "[object Object]"), objects become compact JSON with a
 * depth guard so a circular Discord structure cannot hang the process.
 */
function render(arg) {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'object') {
    try {
      const seen = new WeakSet();
      return JSON.stringify(arg, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        if (typeof v === 'bigint') return `${v}n`;
        return v;
      });
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

class Logger {
  /**
   * @param {string} scope short tag printed in front of every line
   * @param {{ level?: string }} [opts]
   */
  constructor(scope = 'bot', opts = {}) {
    this.scope = scope;
    this.threshold = LEVELS[opts.level || process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
  }

  /** Returns a logger that shares this one's threshold but tags a sub-scope. */
  child(scope) {
    const c = new Logger(`${this.scope}:${scope}`);
    c.threshold = this.threshold;
    return c;
  }

  setLevel(level) {
    if (LEVELS[level] === undefined) return false;
    this.threshold = LEVELS[level];
    return true;
  }

  get level() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === this.threshold) || 'info';
  }

  write(level, args) {
    const entry = {
      at: Date.now(),
      level,
      scope: this.scope,
      msg: args.map(render).join(' '),
    };
    buffer.push(entry);
    if (LEVELS[level] < this.threshold) return;

    const tag = level.toUpperCase().padEnd(5);
    const plain = `${stamp()} ${tag} [${this.scope}] ${entry.msg}\n`;

    if (useColor) {
      process.stdout.write(
        `${COLORS.dim}${stamp()}${COLORS.reset} ${COLORS[level]}${tag}${COLORS.reset} ` +
          `${COLORS.dim}[${this.scope}]${COLORS.reset} ${entry.msg}\n`,
      );
    } else {
      process.stdout.write(plain);
    }

    // The file always gets the uncoloured form, so it stays greppable.
    if (fileSink) fileSink.write(plain);
  }

  trace(...a) {
    this.write('trace', a);
  }

  debug(...a) {
    this.write('debug', a);
  }

  info(...a) {
    this.write('info', a);
  }

  warn(...a) {
    this.write('warn', a);
  }

  error(...a) {
    this.write('error', a);
  }

  fatal(...a) {
    this.write('fatal', a);
  }

  /** Prints a boxed banner. Used once at boot so the start of a run is obvious. */
  banner(lines) {
    const width = Math.max(...lines.map((l) => l.length), 20) + 2;
    const bar = '-'.repeat(width);
    this.write('info', [bar]);
    for (const l of lines) this.write('info', [` ${l}`]);
    this.write('info', [bar]);
  }
}

module.exports = { Logger, LEVELS, buffer, configureFile, fileStats, RotatingFile };
