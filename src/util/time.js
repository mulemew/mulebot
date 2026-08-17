'use strict';

/**
 * Duration parsing and formatting.
 *
 * Parsing accepts what people actually type in chat: "10m", "1h30m", "2 days",
 * "90", "1d 12h". Being liberal here removes a whole class of "invalid
 * duration" complaints without making the format ambiguous, because every unit
 * is explicit and a bare number is documented as seconds.
 */

const UNIT_MS = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  mo: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Parses a duration into milliseconds.
 * Returns null when nothing usable was found.
 *
 * Examples: "30s" -> 30000, "1h30m" -> 5400000, "2 days" -> 172800000,
 *           "45" -> 45000 (a bare number is read as seconds)
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;

  // A bare number means seconds - the single most common shorthand.
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? Math.round(n * SECOND) : null;
  }

  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    const value = Number(m[1]);
    const unit = UNIT_MS[m[2]];
    if (!unit) return null; // an unknown unit is a typo, not a partial match
    total += value * unit;
    matched = true;
  }
  if (!matched || total <= 0) return null;
  return Math.round(total);
}

/**
 * Renders a duration as compact human text: "2d 4h", "45s", "1h 30m".
 * @param {number} ms
 * @param {{ parts?: number, compact?: boolean }} [opts] how many units to show
 */
function formatDuration(ms, opts = {}) {
  const { parts = 2, compact = true } = opts;
  let remaining = Math.abs(Math.round(ms));
  if (remaining < SECOND) return compact ? `${remaining}ms` : `${remaining} milliseconds`;

  const units = [
    [DAY, 'd', 'day'],
    [HOUR, 'h', 'hour'],
    [MINUTE, 'm', 'minute'],
    [SECOND, 's', 'second'],
  ];

  const out = [];
  for (const [size, short, long] of units) {
    if (remaining < size) continue;
    const count = Math.floor(remaining / size);
    remaining -= count * size;
    out.push(compact ? `${count}${short}` : `${count} ${long}${count === 1 ? '' : 's'}`);
    if (out.length >= parts) break;
  }
  return out.join(compact ? ' ' : ', ');
}

/**
 * Discord relative timestamp, e.g. "<t:1700000000:R>" which the client renders
 * as "in 5 minutes" in the reader's own locale and timezone. Always preferable
 * to formatting a date ourselves.
 */
function relative(msEpoch) {
  return `<t:${Math.floor(msEpoch / 1000)}:R>`;
}

/**
 * Discord absolute timestamp.
 * @param {number} msEpoch
 * @param {'t'|'T'|'d'|'D'|'f'|'F'|'R'} [style]
 */
function timestamp(msEpoch, style = 'F') {
  return `<t:${Math.floor(msEpoch / 1000)}:${style}>`;
}

/** Both the absolute and the relative form, which is what most embeds want. */
function fullTimestamp(msEpoch) {
  return `${timestamp(msEpoch, 'F')} (${timestamp(msEpoch, 'R')})`;
}

/** Uptime string for a process that started `since` ms ago. */
function uptime(sinceEpoch) {
  return formatDuration(Date.now() - sinceEpoch, { parts: 3 });
}

/** Milliseconds until the next UTC midnight, offset by a guild's timezone. */
function msUntilMidnight(offsetHours = 0) {
  const now = new Date(Date.now() + offsetHours * HOUR);
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/**
 * True when two timestamps fall on the same local day for a given offset.
 * Used by streak logic: a daily reward should reset at local midnight, not
 * exactly 24 hours after the last claim.
 */
function sameDay(a, b, offsetHours = 0) {
  const shift = offsetHours * HOUR;
  const da = new Date(a + shift);
  const db = new Date(b + shift);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

/** Number of whole local days between two timestamps. */
function daysBetween(a, b, offsetHours = 0) {
  const shift = offsetHours * HOUR;
  const floorDay = (t) => Math.floor((t + shift) / DAY);
  return Math.abs(floorDay(b) - floorDay(a));
}

/** Promise that resolves after `ms`. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Formats a clock duration as mm:ss, used by game timers.
 */
function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Human date like "16 Aug 2026" without pulling in a date library. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(msEpoch) {
  const d = new Date(msEpoch);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Parses a "MM-DD" or "YYYY-MM-DD" birthday string.
 * Returns { month, day, year } or null.
 */
function parseBirthday(input) {
  const m = String(input).trim().match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const year = m[1] ? Number(m[1]) : null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 31 February and friends by round-tripping through Date.
  const probe = new Date(Date.UTC(year || 2000, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Epoch ms of the next occurrence of a month/day pair. */
function nextBirthday({ month, day }, from = Date.now()) {
  const now = new Date(from);
  let year = now.getUTCFullYear();
  let candidate = Date.UTC(year, month - 1, day);
  if (candidate < from) candidate = Date.UTC(++year, month - 1, day);
  return candidate;
}

module.exports = {
  parseDuration,
  formatDuration,
  relative,
  timestamp,
  fullTimestamp,
  uptime,
  msUntilMidnight,
  sameDay,
  daysBetween,
  sleep,
  clock,
  shortDate,
  parseBirthday,
  nextBirthday,
  SECOND,
  MINUTE,
  HOUR,
  DAY,
  WEEK,
  UNIT_MS,
};
