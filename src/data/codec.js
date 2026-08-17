'use strict';

/**
 * Text encodings for the /encode and /decode commands.
 *
 * All of these are reversible, offline transformations. Nothing here is
 * cryptography and the command help says so explicitly - ROT13 and base64 look
 * like secrecy to people who have not met them before, and a bot that implies
 * otherwise will eventually be blamed for a leaked password.
 */

const MORSE = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....',
  i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.',
  q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-',
  y: '-.--', z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--',
  '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...',
  ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-',
  '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
};

const MORSE_REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

const NATO = {
  a: 'Alfa', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot',
  g: 'Golf', h: 'Hotel', i: 'India', j: 'Juliett', k: 'Kilo', l: 'Lima',
  m: 'Mike', n: 'November', o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo',
  s: 'Sierra', t: 'Tango', u: 'Uniform', v: 'Victor', w: 'Whiskey',
  x: 'X-ray', y: 'Yankee', z: 'Zulu',
  0: 'Zero', 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four',
  5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Niner',
};

/** Leet substitutions, applied on encode only. */
const LEET = { a: '4', b: '8', e: '3', g: '9', i: '1', l: '1', o: '0', s: '5', t: '7', z: '2' };

const encoders = {
  base64: (text) => Buffer.from(text, 'utf8').toString('base64'),
  base32: (text) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = Buffer.from(text, 'utf8');
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
    while (out.length % 8 !== 0) out += '=';
    return out;
  },
  hex: (text) => Buffer.from(text, 'utf8').toString('hex'),
  binary: (text) =>
    [...Buffer.from(text, 'utf8')].map((b) => b.toString(2).padStart(8, '0')).join(' '),
  rot13: (text) =>
    text.replace(/[a-z]/gi, (c) => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    }),
  reverse: (text) => [...text].reverse().join(''),
  morse: (text) =>
    [...text.toLowerCase()]
      .map((c) => (c === ' ' ? '/' : MORSE[c] ?? ''))
      .filter(Boolean)
      .join(' '),
  nato: (text) =>
    [...text.toLowerCase()]
      .map((c) => (c === ' ' ? '(space)' : NATO[c] ?? c))
      .join(' '),
  leet: (text) => [...text.toLowerCase()].map((c) => LEET[c] ?? c).join(''),
  url: (text) => encodeURIComponent(text),
  upsidedown: (text) => {
    const map = {
      a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ',
      j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ',
      s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
      '.': '˙', ',': "'", '?': '¿', '!': '¡', "'": ',', '(': ')', ')': '(',
      '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '_': '‾',
      1: 'Ɩ', 2: 'ᄅ', 3: 'Ɛ', 4: 'ㄣ', 5: 'ς', 6: '9', 7: 'ㄥ', 8: '8', 9: '6', 0: '0',
    };
    return [...text.toLowerCase()].reverse().map((c) => map[c] ?? c).join('');
  },
};

const decoders = {
  base64: (text) => {
    const out = Buffer.from(text.trim(), 'base64').toString('utf8');
    // A round trip is the cheapest way to reject input that was not base64;
    // Buffer silently ignores invalid characters instead of throwing.
    if (Buffer.from(out, 'utf8').toString('base64').replace(/=+$/, '') !== text.trim().replace(/=+$/, '')) {
      throw new Error('that is not valid base64');
    }
    return out;
  },
  base32: (text) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
      const idx = alphabet.indexOf(char);
      if (idx === -1) throw new Error('that is not valid base32');
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(bytes).toString('utf8');
  },
  hex: (text) => {
    const clean = text.replace(/\s|0x/gi, '');
    if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) throw new Error('that is not valid hex');
    return Buffer.from(clean, 'hex').toString('utf8');
  },
  binary: (text) => {
    const parts = text.trim().split(/\s+/);
    if (!parts.every((p) => /^[01]{1,8}$/.test(p))) throw new Error('that is not valid binary');
    return Buffer.from(parts.map((p) => parseInt(p, 2))).toString('utf8');
  },
  rot13: (text) => encoders.rot13(text), // ROT13 is its own inverse
  reverse: (text) => encoders.reverse(text),
  morse: (text) =>
    text
      .trim()
      .split(/\s*\/\s*/)
      .map((word) =>
        word
          .split(/\s+/)
          .filter(Boolean)
          .map((code) => MORSE_REVERSE[code] ?? '?')
          .join(''),
      )
      .join(' '),
  url: (text) => decodeURIComponent(text),
};

const ENCODINGS = Object.keys(encoders);
const DECODINGS = Object.keys(decoders);

/**
 * Applies an encoding.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function encode(kind, text) {
  const fn = encoders[kind];
  if (!fn) return { ok: false, error: `unknown encoding "${kind}"` };
  try {
    return { ok: true, value: fn(String(text)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Applies a decoding. */
function decode(kind, text) {
  const fn = decoders[kind];
  if (!fn) return { ok: false, error: `"${kind}" cannot be decoded` };
  try {
    return { ok: true, value: fn(String(text)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { MORSE, MORSE_REVERSE, NATO, LEET, ENCODINGS, DECODINGS, encode, decode };
