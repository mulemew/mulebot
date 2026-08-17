'use strict';

const crypto = require('node:crypto');

/**
 * Randomness helpers.
 *
 * Math.random is fine for flavour text, but anything a user can win money on
 * (gambling, giveaways, loot) uses crypto.randomInt. It is not about
 * cryptography - it is about not having a predictable sequence that a
 * determined user could exploit after watching enough rolls, and about the
 * outcome being defensible when someone accuses the bot of being rigged.
 */

/** Uniform integer in [min, max] inclusive, from a CSPRNG. */
function int(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return crypto.randomInt(lo, hi + 1);
}

/** Uniform float in [0, 1). */
function float() {
  // 32 bits of entropy is plenty for probability checks and keeps this cheap.
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

/** True with probability `p` (0..1). */
function chance(p) {
  return float() < p;
}

/** Random element of an array. Returns undefined for an empty array. */
function pick(arr) {
  if (!arr || !arr.length) return undefined;
  return arr[int(0, arr.length - 1)];
}

/** `n` distinct random elements, or the whole array when it is shorter. */
function sample(arr, n) {
  if (!arr || !arr.length) return [];
  if (n >= arr.length) return shuffle([...arr]);
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n; i++) out.push(...copy.splice(int(0, copy.length - 1), 1));
  return out;
}

/** In-place Fisher-Yates shuffle. Returns the same array for chaining. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = int(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Weighted pick.
 * @param {Array<{ weight?: number }>} entries
 * @returns one entry, or undefined when the list is empty
 */
function weighted(entries) {
  const list = entries.filter((e) => (e.weight ?? 1) > 0);
  if (!list.length) return undefined;
  const total = list.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  let roll = float() * total;
  for (const entry of list) {
    roll -= entry.weight ?? 1;
    if (roll <= 0) return entry;
  }
  return list[list.length - 1];
}

/** Random integer inside a [min, max] pair as stored in settings. */
function inRange(range, fallback = [0, 0]) {
  const [min, max] = Array.isArray(range) && range.length === 2 ? range : fallback;
  return int(Number(min) || 0, Number(max) || 0);
}

/** Short, URL-safe, non-guessable id. Used for game sessions and ticket ids. */
function id(length = 8) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[int(0, alphabet.length - 1)];
  return out;
}

/**
 * A small seeded PRNG (mulberry32). Used where a result must be *reproducible*
 * from an id - a daily puzzle that is the same for everyone in a server, for
 * instance - which a CSPRNG cannot do by design.
 */
function seeded(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to turn a string into a seed. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from a seed - same seed, same answer, forever. */
function seededPick(seed, arr) {
  if (!arr.length) return undefined;
  return arr[Math.floor(seeded(seed)() * arr.length)];
}

/**
 * Rolls dice in NdM notation and reports the individual results.
 * @returns {{ rolls: number[], total: number }}
 */
function dice(count, sides) {
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(int(1, sides));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
}

/** Normally distributed value via Box-Muller, clamped to a range. */
function gaussian(mean, stdDev, min = -Infinity, max = Infinity) {
  let u = 0;
  let v = 0;
  while (u === 0) u = float();
  while (v === 0) v = float();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + n * stdDev));
}

module.exports = {
  int,
  float,
  chance,
  pick,
  sample,
  shuffle,
  weighted,
  inRange,
  id,
  seeded,
  seededPick,
  hashString,
  dice,
  gaussian,
};
