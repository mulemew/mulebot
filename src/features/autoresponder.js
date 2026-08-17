'use strict';

const rng = require('../util/random');
const { escapeRegex, template, truncate } = require('../util/text');

/**
 * Auto-responders: message triggers that produce a canned reply.
 *
 * The interesting part is the regex mode. Letting server admins supply an
 * arbitrary regular expression that runs against every message is a denial of
 * service waiting to happen - a pattern like (a+)+$ takes exponential time on
 * the right input, and it only takes one member to send that input.
 *
 * Mitigations applied here:
 *   - patterns are compiled once at save time, not per message
 *   - patterns longer than 200 characters are rejected
 *   - nested quantifiers, the classic catastrophic-backtracking shape, are
 *     rejected outright with an explanation
 *   - matching runs against a truncated copy of the message
 */

const MAX_PATTERN_LENGTH = 200;
const MAX_SCAN_LENGTH = 1000;
const MAX_ENTRIES = 50;

/** Shapes known to backtrack catastrophically. */
const DANGEROUS = [
  /\([^)]*[+*]\)[+*]/, //  (a+)+  (a*)*
  /\([^)]*\{\d+,\}\)[+*{]/, //  (a{2,})+
];

function init(bot) {
  const log = bot.log.child('autoresponder');

  /** guildId -> compiled entries, rebuilt when settings change. */
  const compiled = new Map();

  function compile(guildId) {
    const entries = bot.db.settings(guildId).autoresponder.entries || [];
    const out = [];
    for (const entry of entries) {
      if (entry.match === 'regex') {
        try {
          out.push({ ...entry, regex: new RegExp(entry.trigger, 'i') });
        } catch (e) {
          log.warn(`invalid autoresponder regex in guild ${guildId}: ${e.message}`);
        }
      } else {
        out.push({ ...entry });
      }
    }
    compiled.set(guildId, out);
    return out;
  }

  const api = {
    MAX_ENTRIES,

    /** Validates a trigger before it is stored. Returns an error string or null. */
    validate({ trigger, match }) {
      if (!trigger || !trigger.trim()) return 'The trigger cannot be empty.';
      if (trigger.length > MAX_PATTERN_LENGTH) return `The trigger must be under ${MAX_PATTERN_LENGTH} characters.`;
      if (match !== 'regex') return null;

      if (DANGEROUS.some((d) => d.test(trigger))) {
        return 'That pattern contains a nested quantifier such as `(a+)+`, which can hang the bot on crafted input. Rewrite it without nesting.';
      }
      try {
        new RegExp(trigger, 'i');
      } catch (e) {
        return `That is not a valid regular expression: ${e.message}`;
      }
      return null;
    },

    /** Invalidate the compiled cache for a guild, called after any edit. */
    invalidate(guildId) {
      compiled.delete(guildId);
    },

    entries(guildId) {
      return compiled.get(guildId) || compile(guildId);
    },

    /** Adds an entry, returning { ok, error }. */
    add(guildId, entry) {
      const settings = bot.db.settings(guildId);
      const list = settings.autoresponder.entries || [];
      if (list.length >= MAX_ENTRIES) return { ok: false, error: `A server can have at most ${MAX_ENTRIES} auto-responders.` };

      const problem = api.validate(entry);
      if (problem) return { ok: false, error: problem };

      if (list.some((e) => e.trigger.toLowerCase() === entry.trigger.toLowerCase())) {
        return { ok: false, error: 'An auto-responder with that trigger already exists.' };
      }

      list.push({
        trigger: entry.trigger,
        response: truncate(entry.response, 1800),
        match: entry.match || 'contains',
        chance: Math.min(1, Math.max(0.01, entry.chance ?? 1)),
        deleteTrigger: Boolean(entry.deleteTrigger),
        createdBy: entry.createdBy || null,
        createdAt: Date.now(),
        uses: 0,
      });
      bot.db.setSetting(guildId, 'autoresponder.entries', list);
      api.invalidate(guildId);
      return { ok: true };
    },

    remove(guildId, trigger) {
      const list = bot.db.settings(guildId).autoresponder.entries || [];
      const next = list.filter((e) => e.trigger.toLowerCase() !== String(trigger).toLowerCase());
      if (next.length === list.length) return false;
      bot.db.setSetting(guildId, 'autoresponder.entries', next);
      api.invalidate(guildId);
      return true;
    },

    /** Records a use so /autoresponder list can show which ones earn their keep. */
    countUse(guildId, trigger) {
      const list = bot.db.settings(guildId).autoresponder.entries || [];
      const entry = list.find((e) => e.trigger === trigger);
      if (!entry) return;
      entry.uses = (entry.uses || 0) + 1;
      bot.db.setSetting(guildId, 'autoresponder.entries', list);
    },

    /** Tests one entry against a message body. */
    matches(entry, content) {
      const body = content.slice(0, MAX_SCAN_LENGTH);
      const needle = entry.trigger.toLowerCase();
      const hay = body.toLowerCase();

      switch (entry.match) {
        case 'exact':
          return hay.trim() === needle;
        case 'starts':
          return hay.startsWith(needle);
        case 'ends':
          return hay.endsWith(needle);
        case 'word':
          return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(body);
        case 'regex':
          return entry.regex ? entry.regex.test(body) : false;
        case 'contains':
        default:
          return hay.includes(needle);
      }
    },

    /**
     * Message hook.
     * @returns {Promise<boolean>} whether a response was sent
     */
    async onMessage(message) {
      if (!message.guild || message.author.bot) return false;
      const settings = bot.db.settings(message.guildId);
      if (!settings.autoresponder.enabled) return false;
      if (!message.content) return false;

      for (const entry of api.entries(message.guildId)) {
        if (!api.matches(entry, message.content)) continue;
        if (entry.chance < 1 && !rng.chance(entry.chance)) continue;

        const body = template(entry.response, {
          user: `<@${message.author.id}>`,
          username: message.author.username,
          tag: message.author.tag,
          server: message.guild.name,
          channel: `<#${message.channelId}>`,
          count: String(message.guild.memberCount),
        });

        if (entry.deleteTrigger) await message.delete().catch(() => {});

        await message.channel
          .send({ content: truncate(body, 2000), allowedMentions: { users: [message.author.id] } })
          .catch(() => {});

        api.countUse(message.guildId, entry.trigger);
        return true; // only ever fire one responder per message
      }
      return false;
    },
  };

  return api;
}

module.exports = { name: 'autoresponder', init, MAX_ENTRIES };
