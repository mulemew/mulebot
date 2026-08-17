'use strict';

const { EmbedBuilder } = require('discord.js');
const { truncate, LIMITS } = require('./text');

/**
 * Embed factory.
 *
 * Two reasons this is not just `new EmbedBuilder()` everywhere:
 *
 *   1. Consistency. Colour, timestamp and footer style are decided once. A
 *      command that forgets is visually out of place.
 *   2. Safety. Every string is truncated to Discord's limit on the way in, so a
 *      3000-character reason from a moderator produces a clipped embed instead
 *      of a rejected request the user sees as "something went wrong".
 */

const PALETTE = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  info: 0x3498db,
  neutral: 0x2b2d31,
  gold: 0xf1c40f,
  purple: 0x9b59b6,
  pink: 0xeb459e,
};

/** Overridden at boot from config so operators can rebrand the bot. */
let theme = { ...PALETTE };

function configure(colors = {}) {
  theme = { ...PALETTE, ...colors };
}

/**
 * Base embed.
 * @param {string} [title]
 * @param {string} [description]
 * @param {number} [color]
 */
function base(title, description, color = theme.primary) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (title) e.setTitle(truncate(title, LIMITS.embedTitle));
  if (description) e.setDescription(truncate(description, LIMITS.embedDescription));
  return e;
}

const info = (title, description) => base(title, description, theme.info);
const success = (title, description) => base(title ? `✅ ${title}` : null, description, theme.success);
const warning = (title, description) => base(title ? `⚠️ ${title}` : null, description, theme.warning);
const error = (title, description) => base(title ? `❌ ${title}` : null, description, theme.danger);
const neutral = (title, description) => base(title, description, theme.neutral);

/**
 * Adds a field with both name and value truncated. Silently skips empty values
 * because Discord rejects a field with an empty value, which is an easy way to
 * break an otherwise fine embed when a list happens to be empty.
 */
function field(embed, name, value, inline = false) {
  const v = String(value ?? '').trim();
  if (!v) return embed;
  embed.addFields({
    name: truncate(name, LIMITS.fieldName),
    value: truncate(v, LIMITS.fieldValue),
    inline,
  });
  return embed;
}

/**
 * Adds many fields at once from an object, skipping empty entries.
 * @param {EmbedBuilder} embed
 * @param {Record<string, string>} obj
 */
function fields(embed, obj, inline = false) {
  for (const [name, value] of Object.entries(obj)) field(embed, name, value, inline);
  return embed;
}

/** Stamps the author block from a Discord user. */
function author(embed, user) {
  if (!user) return embed;
  embed.setAuthor({
    name: truncate(user.tag || user.username || 'unknown', LIMITS.embedAuthor),
    iconURL: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : undefined,
  });
  return embed;
}

/** Standard footer: who ran the command, plus optional extra text. */
function footer(embed, user, extra = '') {
  const name = user?.tag || user?.username;
  const text = [name ? `Requested by ${name}` : null, extra].filter(Boolean).join(' • ');
  if (!text) return embed;
  embed.setFooter({
    text: truncate(text, LIMITS.embedFooter),
    iconURL: user && typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 64 }) : undefined,
  });
  return embed;
}

/**
 * Guards the 6000-character total budget across every part of an embed.
 * Returns true when the embed is safe to send.
 */
function withinLimits(embed) {
  const data = embed.data || embed;
  let total = 0;
  total += (data.title || '').length;
  total += (data.description || '').length;
  total += (data.footer?.text || '').length;
  total += (data.author?.name || '').length;
  for (const f of data.fields || []) total += (f.name || '').length + (f.value || '').length;
  return total <= LIMITS.embedTotal && (data.fields?.length || 0) <= LIMITS.fields;
}

/**
 * Builds a list embed from lines, splitting into fields when the description
 * would overflow. Used by every leaderboard and listing command.
 */
function list(title, lines, { color = theme.primary, perField = 10, description = '' } = {}) {
  const e = base(title, description, color);
  const body = lines.join('\n');
  if (body.length <= LIMITS.embedDescription && lines.length <= perField * 3) {
    e.setDescription(truncate([description, body].filter(Boolean).join('\n\n'), LIMITS.embedDescription));
    return e;
  }
  for (let i = 0; i < lines.length; i += perField) {
    const slice = lines.slice(i, i + perField);
    field(e, `${i + 1}–${i + slice.length}`, slice.join('\n'));
    if ((e.data.fields?.length || 0) >= LIMITS.fields) break;
  }
  return e;
}

/** Key/value embed where every entry is inline, e.g. /serverinfo. */
function stats(title, entries, color = theme.primary) {
  const e = base(title, null, color);
  for (const [name, value] of Object.entries(entries)) field(e, name, value, true);
  return e;
}

module.exports = {
  configure,
  base,
  info,
  success,
  warning,
  error,
  neutral,
  field,
  fields,
  author,
  footer,
  list,
  stats,
  withinLimits,
  PALETTE,
  get theme() {
    return theme;
  },
};
