'use strict';

/**
 * Text helpers.
 *
 * Discord has hard character limits everywhere (2000 per message, 4096 per
 * embed description, 1024 per field value, 256 per title). Exceeding any of
 * them is a 400 from the API, which surfaces to the user as "something went
 * wrong" with no clue why. Everything user-generated therefore goes through a
 * truncator before it is sent.
 */

const LIMITS = {
  message: 2000,
  embedDescription: 4096,
  embedTitle: 256,
  fieldName: 256,
  fieldValue: 1024,
  embedFooter: 2048,
  embedAuthor: 256,
  embedTotal: 6000,
  fields: 25,
  selectLabel: 100,
  selectDescription: 100,
  buttonLabel: 80,
  customId: 100,
  modalValue: 4000,
};

/** Shortens text to `max`, appending an ellipsis when it had to cut. */
function truncate(input, max = 2000, suffix = '…') {
  const s = String(input ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * Escapes Discord markdown so a user-supplied nickname cannot inject formatting
 * (or worse, break out of a code block) into a moderation log.
 */
function escapeMarkdown(input) {
  return String(input ?? '').replace(/([\\*_~`|>])/g, '\\$1');
}

/** Strips every mention-like construct so echoed text cannot ping anyone. */
function stripMentions(input) {
  return String(input ?? '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/<@[!&]?(\d+)>/g, '[mention]');
}

/** Wraps text in a fenced code block with an optional language tag. */
function codeBlock(content, lang = '') {
  const body = String(content ?? '').replace(/```/g, '`​``');
  return `\`\`\`${lang}\n${truncate(body, 1900)}\n\`\`\``;
}

/** Inline code, with backticks in the payload neutralised. */
function inlineCode(content) {
  return `\`${String(content ?? '').replace(/`/g, '​`')}\``;
}

/** "1,234,567" for any number, using the invariant grouping. */
function number(n) {
  const value = Number(n) || 0;
  return value.toLocaleString('en-US');
}

/** Compact form for large counts: 1.2k, 3.4M. */
function compactNumber(n) {
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

/** "1st", "2nd", "3rd", "11th". */
function ordinal(n) {
  const v = Number(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const mod = v % 100;
  return v + (s[(mod - 20) % 10] || s[mod] || s[0]);
}

/** "1 apple" / "2 apples", with an optional irregular plural. */
function plural(count, singular, pluralForm = null) {
  return `${number(count)} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}

/**
 * A unicode progress bar. Used by level cards, poll results and game timers.
 * @param {number} ratio 0..1
 * @param {number} width characters
 */
function progressBar(ratio, width = 20, { filled = '█', empty = '░' } = {}) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const done = Math.round(clamped * width);
  return filled.repeat(done) + empty.repeat(Math.max(0, width - done));
}

/**
 * Fixed-width table rendered for a code block. Column widths come from the
 * widest cell, which keeps leaderboards readable on both desktop and mobile as
 * long as the total stays under about 60 characters.
 */
function table(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  const pad = (cell, i) => (align[i] === 'right' ? cell.padStart(widths[i]) : cell.padEnd(widths[i]));
  const line = (r) => r.map((c, i) => pad(c, i)).join('  ').trimEnd();
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(all[0]), divider, ...all.slice(1).map(line)].join('\n');
}

/** Splits a long body into chunks that each fit a message, cutting at newlines. */
function chunk(text, size = LIMITS.message) {
  const out = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    if (current.length + line.length + 1 > size) {
      if (current) out.push(current);
      // A single line longer than the limit still has to be split somewhere.
      if (line.length > size) {
        for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
        current = '';
        continue;
      }
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Title Case for a slug or snake_case identifier. */
function titleCase(input) {
  return String(input ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Percentage of a ratio, e.g. pct(3, 4) -> "75%". */
function pct(part, total, digits = 0) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(digits)}%`;
}

/**
 * Levenshtein distance, capped for speed. Powers "did you mean" suggestions
 * when a prefix command is misspelled.
 */
function distance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 0; i < s.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < t.length; j++) {
      const cost = s[i] === t[j] ? 0 : 1;
      cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/** Closest match from a list, or null when nothing is close enough. */
function closest(query, candidates, maxDistance = 3) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(String(query).toLowerCase(), String(c).toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= maxDistance ? best : null;
}

/**
 * Ratio of uppercase letters, ignoring non-letters. Used by the caps automod
 * rule; counting raw uppercase would flag "OK!!!" and numeric strings.
 */
function capsRatio(input) {
  const letters = String(input).replace(/[^\p{L}]/gu, '');
  if (!letters.length) return 0;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length;
}

/** Detects zalgo / combining-mark spam by counting diacritics per character. */
function zalgoScore(input) {
  const s = String(input);
  if (!s.length) return 0;
  const marks = (s.match(/[̀-ͯ҃-҉᪰-᫿⃐-⃰]/g) || []).length;
  return marks / s.length;
}

/** Counts custom and unicode emoji in a string. */
function countEmoji(input) {
  const s = String(input);
  const custom = (s.match(/<a?:\w+:\d+>/g) || []).length;
  const unicode = (s.match(/\p{Extended_Pictographic}/gu) || []).length;
  return custom + unicode;
}

/** Finds Discord invite links, returning the invite codes. */
function findInvites(input) {
  const re = /(?:discord(?:\.gg|(?:app)?\.com\/invite|\.me)|invite\.gg)\/([a-z0-9-]{2,32})/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(input))) !== null) out.push(m[1]);
  return out;
}

/** Extracts hostnames from any URLs in the text. */
function findDomains(input) {
  const re = /https?:\/\/([^\s/$.?#][^\s/]*)/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(input))) !== null) out.push(m[1].toLowerCase().replace(/^www\./, ''));
  return out;
}

/**
 * Normalises text for word filters: strips diacritics, collapses common
 * lookalike substitutions and removes separators, so "f-r-e-e n1tro" and
 * "frée  nitro" both reduce to the same comparable form.
 */
function normalizeForFilter(input) {
  return String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5\$/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z0-9]+/g, '');
}

/** Escapes a string for safe inclusion in a RegExp. */
function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns "a, b and c" out of a list, which reads better than a bare join in
 * user-facing sentences.
 */
function humanList(items, conjunction = 'and') {
  const list = items.map(String).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${list[list.length - 1]}`;
}

/** Pads a string to a fixed display width, used inside code blocks. */
function pad(input, width, char = ' ') {
  const s = String(input ?? '');
  return s.length >= width ? s : s + char.repeat(width - s.length);
}

function padStart(input, width, char = ' ') {
  const s = String(input ?? '');
  return s.length >= width ? s : char.repeat(width - s.length) + s;
}

/** Replaces {placeholders} from a context object, used by welcome templates. */
function template(str, vars) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

module.exports = {
  LIMITS,
  truncate,
  escapeMarkdown,
  stripMentions,
  codeBlock,
  inlineCode,
  number,
  compactNumber,
  ordinal,
  plural,
  progressBar,
  table,
  chunk,
  titleCase,
  pct,
  distance,
  closest,
  capsRatio,
  zalgoScore,
  countEmoji,
  findInvites,
  findDomains,
  normalizeForFilter,
  escapeRegex,
  humanList,
  pad,
  padStart,
  template,
};
