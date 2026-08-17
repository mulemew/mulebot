'use strict';

const { PermissionFlagsBits } = require('discord.js');
const embeds = require('../util/embeds');
const text = require('../util/text');
const { formatDuration } = require('../util/time');

/**
 * Automod.
 *
 * Every rule is a small pure-ish function that inspects a message and returns
 * either null or a violation object. That shape matters: rules stay independent,
 * a new one is a single function, and the ordering below decides which
 * violation is reported when a message trips several at once.
 *
 * Two safety rails apply everywhere:
 *   - staff and exempt roles are never inspected, checked once up front
 *   - the bot never acts on a member it cannot act on, so a failed moderation
 *     action degrades to deleting the message rather than looping on errors
 */

/** Rule order decides which violation wins when several match. */
const RULE_ORDER = [
  'words',
  'invites',
  'links',
  'attachments',
  'spam',
  'duplicates',
  'mentions',
  'caps',
  'emoji',
  'walls',
  'zalgo',
  'newAccount',
];

function init(bot) {
  const log = bot.log.child('automod');

  /**
   * Recent message fingerprints per member, for the spam and duplicate rules.
   * Kept in memory only: persisting it would write on every single message for
   * data that is worthless after thirty seconds.
   */
  const recent = new Map(); // `${guildId}:${userId}` -> [{ at, hash, channelId }]

  /** Automod strikes for escalation, also memory-only and time-windowed. */
  const strikes = new Map(); // `${guildId}:${userId}` -> [timestamps]

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, list] of recent) {
      const live = list.filter((e) => e.at > cutoff);
      if (live.length) recent.set(key, live);
      else recent.delete(key);
    }
    for (const [key, list] of strikes) {
      const live = list.filter((t) => t > Date.now() - 6 * 60 * 60_000);
      if (live.length) strikes.set(key, live);
      else strikes.delete(key);
    }
  }, 60_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  // ---------- rules ----------

  const rules = {
    invites(message, rule) {
      const codes = text.findInvites(message.content);
      if (!codes.length) return null;
      // An invite to this same server is not advertising, it is a member being
      // helpful. Allow-listing it removes the most common false positive.
      const allowed = new Set([...(rule.allowList || []), message.guild.vanityURLCode].filter(Boolean));
      const offending = codes.filter((c) => !allowed.has(c));
      if (!offending.length) return null;
      return { rule: 'invites', detail: `invite link (${offending[0]})` };
    },

    links(message, rule) {
      const domains = text.findDomains(message.content);
      if (!domains.length) return null;

      const block = (rule.blockList || []).map((d) => d.toLowerCase());
      if (block.length) {
        const hit = domains.find((d) => block.some((b) => d === b || d.endsWith(`.${b}`)));
        return hit ? { rule: 'links', detail: `blocked domain (${hit})` } : null;
      }

      const allow = (rule.allowList || []).map((d) => d.toLowerCase());
      if (allow.length) {
        const hit = domains.find((d) => !allow.some((a) => d === a || d.endsWith(`.${a}`)));
        return hit ? { rule: 'links', detail: `link to ${hit}` } : null;
      }
      return { rule: 'links', detail: `link to ${domains[0]}` };
    },

    mentions(message, rule) {
      const count = message.mentions.users.size + message.mentions.roles.size;
      if (count <= (rule.limit || 5)) return null;
      return { rule: 'mentions', detail: `${count} mentions in one message` };
    },

    caps(message, rule) {
      if (message.content.length < (rule.minLength || 12)) return null;
      const ratio = text.capsRatio(message.content);
      if (ratio * 100 < (rule.percent || 70)) return null;
      return { rule: 'caps', detail: `${Math.round(ratio * 100)}% capital letters` };
    },

    spam(message, rule) {
      const key = `${message.guildId}:${message.author.id}`;
      const window = (rule.seconds || 5) * 1000;
      const list = (recent.get(key) || []).filter((e) => Date.now() - e.at < window);
      if (list.length + 1 < (rule.messages || 5)) return null;
      return { rule: 'spam', detail: `${list.length + 1} messages in ${rule.seconds || 5}s` };
    },

    duplicates(message, rule) {
      if (message.content.length < 5) return null;
      const key = `${message.guildId}:${message.author.id}`;
      const window = (rule.window || 30) * 1000;
      const hash = text.normalizeForFilter(message.content);
      const matches = (recent.get(key) || []).filter((e) => Date.now() - e.at < window && e.hash === hash);
      if (matches.length + 1 < (rule.limit || 3)) return null;
      return { rule: 'duplicates', detail: `the same message ${matches.length + 1} times` };
    },

    words(message, rule) {
      const list = rule.list || [];
      if (!list.length) return null;
      const haystack = rule.wildcard ? text.normalizeForFilter(message.content) : message.content.toLowerCase();
      for (const word of list) {
        const needle = rule.wildcard ? text.normalizeForFilter(word) : word.toLowerCase();
        if (!needle) continue;
        if (rule.wildcard ? haystack.includes(needle) : new RegExp(`\\b${text.escapeRegex(needle)}\\b`).test(haystack)) {
          // The matched word is never echoed back into the channel, only into
          // the log - repeating a slur to "explain" the deletion is worse than
          // the original message.
          return { rule: 'words', detail: 'a filtered word', private: word };
        }
      }
      return null;
    },

    emoji(message, rule) {
      const count = text.countEmoji(message.content);
      if (count <= (rule.limit || 10)) return null;
      return { rule: 'emoji', detail: `${count} emoji in one message` };
    },

    zalgo(message) {
      if (text.zalgoScore(message.content) < 0.2) return null;
      return { rule: 'zalgo', detail: 'combining-character spam' };
    },

    attachments(message, rule) {
      if (!message.attachments.size) return null;
      const blocked = (rule.blockedExtensions || []).map((e) => e.toLowerCase().replace(/^\./, ''));
      for (const attachment of message.attachments.values()) {
        const ext = (attachment.name || '').split('.').pop()?.toLowerCase();
        if (ext && blocked.includes(ext)) return { rule: 'attachments', detail: `a .${ext} attachment` };
      }
      return null;
    },

    newAccount(message, rule) {
      const ageHours = (Date.now() - message.author.createdTimestamp) / 3_600_000;
      if (ageHours >= (rule.minAgeHours || 24)) return null;
      return { rule: 'newAccount', detail: `account is ${Math.round(ageHours)}h old` };
    },

    walls(message, rule) {
      const lines = message.content.split('\n').length;
      if (lines <= (rule.lines || 12)) return null;
      return { rule: 'walls', detail: `${lines} lines in one message` };
    },
  };

  // ---------- pipeline ----------

  const api = {
    rules: Object.keys(rules),

    /** True when this message should never be inspected. */
    exempt(message, settings) {
      if (message.author.bot) return true;
      if (!message.guild) return true;
      if (settings.automod.exemptUsers.includes(message.author.id)) return true;
      if (settings.automod.exemptChannels.includes(message.channelId)) return true;
      if (message.member?.roles.cache.some((r) => settings.automod.exemptRoles.includes(r.id))) return true;
      // Anyone who can manage messages is trusted by definition; automod exists
      // to police members, not staff.
      if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
      return false;
    },

    /**
     * Runs every enabled rule against a message.
     * @returns {Promise<object|null>} the violation that was acted on
     */
    async inspect(message) {
      if (!bot.config.features.automod) return null;
      if (!message.guild) return null;

      const settings = bot.db.settings(message.guildId);
      if (!settings.automod.enabled) return null;
      if (api.exempt(message, settings)) return null;

      const key = `${message.guildId}:${message.author.id}`;

      let violation = null;
      for (const name of RULE_ORDER) {
        const rule = settings.automod.rules[name];
        if (!rule?.enabled) continue;
        try {
          const hit = rules[name](message, rule);
          if (hit) {
            violation = { ...hit, action: rule.action || 'delete', config: rule };
            break;
          }
        } catch (e) {
          log.warn(`rule ${name} threw: ${e.message}`);
        }
      }

      // Track history after the rules run, so a message is never compared
      // against itself by the spam and duplicate rules.
      const history = recent.get(key) || [];
      history.push({ at: Date.now(), hash: text.normalizeForFilter(message.content), channelId: message.channelId });
      recent.set(key, history.slice(-30));

      if (!violation) return null;
      await api.punish(message, violation, settings);
      return violation;
    },

    /** Applies the configured action for a violation, then escalation. */
    async punish(message, violation, settings) {
      const reason = `Automod: ${violation.detail}`;

      // Deletion is implied by every action except 'none' - a message that
      // earned a ban should not stay in the channel.
      if (violation.action !== 'none') {
        await message.delete().catch(() => {});
      }

      if (violation.action !== 'delete' && violation.action !== 'none' && message.member) {
        const durationMs = (violation.config.timeoutMinutes || 5) * 60_000;
        const applied = await bot.features.moderation?.apply(violation.action, message.member, {
          reason,
          durationMs,
          moderator: null,
        });
        if (!applied) log.debug(`could not apply ${violation.action} to ${message.author.tag}`);
      }

      await api.warnMember(message, violation);
      await api.logViolation(message, violation, settings);
      await api.escalate(message, settings);
    },

    /** Short, self-deleting notice in the channel so the member knows why. */
    async warnMember(message, violation) {
      if (!message.channel?.isTextBased()) return;
      const notice = await message.channel
        .send({
          content: `<@${message.author.id}> that message was removed: ${violation.detail}.`,
          allowedMentions: { users: [message.author.id] },
        })
        .catch(() => null);
      // Leaving the notice behind turns the channel into a wall of automod
      // messages, which is worse than the spam it removed.
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000);
    },

    async logViolation(message, violation, settings) {
      if (!settings.logging.enabled || !settings.logging.events.automod) return;
      const embed = embeds
        .base('Automod', null, embeds.theme.warning)
        .addFields(
          { name: 'Member', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
          { name: 'Rule', value: `${violation.rule} → ${violation.action}`, inline: true },
          { name: 'Detail', value: violation.private ? `${violation.detail} (\`${violation.private}\`)` : violation.detail },
          { name: 'Content', value: text.truncate(text.codeBlock(message.content || '(no text)'), 1024) },
        );
      await bot.features.logging?.post(message.guild, 'automod', embed);
    },

    /** N strikes inside the window trigger a heavier, configured action. */
    async escalate(message, settings) {
      const esc = settings.automod.escalation;
      if (!esc?.enabled || !message.member) return;

      const key = `${message.guildId}:${message.author.id}`;
      const window = (esc.windowMinutes || 60) * 60_000;
      const list = (strikes.get(key) || []).filter((t) => Date.now() - t < window);
      list.push(Date.now());
      strikes.set(key, list);

      if (list.length < (esc.strikes || 3)) return;
      strikes.delete(key); // reset so one escalation does not fire repeatedly

      const durationMs = (esc.timeoutMinutes || 10) * 60_000;
      const applied = await bot.features.moderation?.apply(esc.action || 'timeout', message.member, {
        reason: `Automod escalation: ${list.length} violations in ${formatDuration(window)}`,
        durationMs,
      });
      if (applied) {
        log.info(`escalated on ${message.author.tag} in ${message.guild.name}: ${esc.action}`);
      }
    },

    /** Diagnostic snapshot for /automod status. */
    status(guildId) {
      const settings = bot.db.settings(guildId);
      return {
        enabled: settings.automod.enabled,
        rules: Object.entries(settings.automod.rules)
          .filter(([, r]) => r.enabled)
          .map(([name, r]) => ({ name, action: r.action })),
        escalation: settings.automod.escalation,
        exemptRoles: settings.automod.exemptRoles.length,
        tracked: recent.size,
      };
    },

    shutdown() {
      clearInterval(sweeper);
    },
  };

  return api;
}

module.exports = { name: 'automod', init, RULE_ORDER };
