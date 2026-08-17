'use strict';

/**
 * Named colours and colour maths for /color.
 *
 * Discord role colours are plain 24-bit integers, so the command needs to
 * accept the forms people actually have to hand: "#ff0000", "ff0000", "red",
 * "rgb(255,0,0)", "hsl(0,100%,50%)" or a bare decimal. Everything normalises to
 * an integer, and the reverse conversions exist so the reply can show the same
 * colour in every notation without a dependency.
 */

const NAMED = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000,
  darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dodgerblue: 0x1e90ff,
  firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520,
  gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f, honeydew: 0xf0fff0,
  hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0,
  khaki: 0xf0e68c, lavender: 0xe6e6fa, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6, lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa, lightslategray: 0x778899, lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6,
  magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080,
  oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500,
  orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
  paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5,
  peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd,
  powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000,
  rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072,
  sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d,
  silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090,
  snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c,
  teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0,
  violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5,
  yellow: 0xffff00, yellowgreen: 0x9acd32,
  // Discord's own palette, which is what most people are actually asking for.
  blurple: 0x5865f2, discordgreen: 0x57f287, discordyellow: 0xfee75c,
  discordred: 0xed4245, discordgray: 0x2b2d31, fuchsiapink: 0xeb459e,
};

const NAMES = Object.keys(NAMED);

/**
 * Parses any supported colour notation into a 24-bit integer.
 * @returns {number|null}
 */
function parse(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;

  if (raw === 'random') return Math.floor(Math.random() * 0x1000000);
  if (raw in NAMED) return NAMED[raw];

  // #rgb / #rrggbb, with or without the hash
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(hex)) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
    return (r << 16) | (g << 8) | b;
  }
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);

  // rgb(r, g, b)
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((n) => Math.min(255, Number(n)));
    return (r << 16) | (g << 8) | b;
  }

  // hsl(h, s%, l%)
  const hsl = raw.match(/^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%?\s*,\s*(\d+(?:\.\d+)?)%?/);
  if (hsl) {
    const [h, s, l] = hsl.slice(1, 4).map(Number);
    return hslToInt(h, s / 100, l / 100);
  }

  // Bare decimal, which is what the Discord API itself uses.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && n <= 0xffffff) return n;
  }

  return null;
}

function toHex(int) {
  return `#${int.toString(16).padStart(6, '0')}`;
}

function toRgb(int) {
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function rgbString(int) {
  const { r, g, b } = toRgb(int);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Standard RGB -> HSL conversion. Returns degrees and percentages. */
function toHsl(int) {
  const { r, g, b } = toRgb(int);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslString(int) {
  const { h, s, l } = toHsl(int);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function hslToInt(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const [r, g, b] = rgb.map((v) => Math.round((v + m) * 255));
  return (r << 16) | (g << 8) | b;
}

/** Relative luminance, used to decide whether text on this colour should be dark. */
function luminance(int) {
  const { r, g, b } = toRgb(int);
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The closest named colour, by squared RGB distance. */
function nearestName(int) {
  const { r, g, b } = toRgb(int);
  let best = null;
  let bestDistance = Infinity;
  for (const [name, value] of Object.entries(NAMED)) {
    const c = toRgb(value);
    const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return { name: best, exact: bestDistance === 0 };
}

/** Complementary colour, i.e. the hue rotated 180 degrees. */
function complement(int) {
  const { h, s, l } = toHsl(int);
  return hslToInt((h + 180) % 360, s / 100, l / 100);
}

/** Five-step shade ramp from the given colour, useful for palette previews. */
function shades(int, steps = 5) {
  const { h, s } = toHsl(int);
  const out = [];
  for (let i = 1; i <= steps; i++) {
    out.push(hslToInt(h, s / 100, (i / (steps + 1)) * 0.9 + 0.05));
  }
  return out;
}

module.exports = {
  NAMED,
  NAMES,
  parse,
  toHex,
  toRgb,
  rgbString,
  toHsl,
  hslString,
  hslToInt,
  luminance,
  contrast,
  nearestName,
  complement,
  shades,
};
