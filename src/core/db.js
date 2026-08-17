'use strict';

const path = require('node:path');
const { JsonStore } = require('./store');

/**
 * Database layer.
 *
 * Wraps a handful of JsonStore collections behind typed accessors so the rest
 * of the code never touches raw paths. Two rules keep this maintainable:
 *
 *   1. Every guild setting has a default in DEFAULT_GUILD. Reading a setting
 *      always goes through settings(guildId), which merges stored values over
 *      the defaults, so a store written by an older version keeps working after
 *      a new setting is added - no migration step required.
 *   2. Nothing outside this file assumes a file layout. Swapping JSON for a real
 *      database later means rewriting this module only.
 */

/**
 * The complete per-guild settings schema.
 * Adding a key here is all that is needed to introduce a new setting.
 */
const DEFAULT_GUILD = {
  locale: null, // null means "use the process default"
  prefix: null, // null means "use the process default"
  timezoneOffset: 0, // hours, used for daily reset boundaries

  welcome: {
    enabled: false,
    channelId: null,
    message: 'Welcome {user} to **{server}**! You are member #{count}.',
    embed: true,
    dm: false,
    dmMessage: 'Welcome to **{server}**! Have a look at the rules channel.',
    imageBanner: null,
    deleteAfter: 0, // seconds, 0 keeps the message
  },
  goodbye: {
    enabled: false,
    channelId: null,
    message: '**{tag}** left the server. We are down to {count} members.',
    embed: true,
  },
  autorole: {
    enabled: false,
    roleIds: [],
    botRoleIds: [],
    delaySeconds: 0,
  },

  logging: {
    enabled: false,
    channelId: null,
    // Each event can be routed to its own channel; null falls back to channelId.
    overrides: {},
    events: {
      messageDelete: true,
      messageUpdate: true,
      messageBulkDelete: true,
      memberJoin: true,
      memberLeave: true,
      memberUpdate: true,
      memberBan: true,
      memberUnban: true,
      memberKick: true,
      memberTimeout: true,
      roleCreate: false,
      roleDelete: false,
      roleUpdate: false,
      channelCreate: false,
      channelDelete: false,
      channelUpdate: false,
      voiceJoin: false,
      voiceLeave: false,
      voiceMove: false,
      commandUse: false,
      automod: true,
    },
    ignoredChannels: [],
    ignoredUsers: [],
  },

  automod: {
    enabled: false,
    // Roles and channels that are never inspected.
    exemptRoles: [],
    exemptChannels: [],
    exemptUsers: [],
    // Every rule shares the same shape: enabled + action + rule-specific fields.
    // action is one of: delete, warn, timeout, kick, ban, none
    rules: {
      invites: { enabled: false, action: 'delete', allowList: [] },
      links: { enabled: false, action: 'delete', allowList: [], blockList: [] },
      mentions: { enabled: false, action: 'warn', limit: 5 },
      caps: { enabled: false, action: 'delete', percent: 70, minLength: 12 },
      spam: { enabled: false, action: 'timeout', messages: 5, seconds: 5, timeoutMinutes: 5 },
      duplicates: { enabled: false, action: 'delete', window: 30, limit: 3 },
      words: { enabled: false, action: 'delete', list: [], wildcard: true },
      emoji: { enabled: false, action: 'delete', limit: 10 },
      zalgo: { enabled: false, action: 'delete' },
      attachments: { enabled: false, action: 'delete', blockedExtensions: ['exe', 'bat', 'cmd', 'scr', 'js', 'vbs'] },
      newAccount: { enabled: false, action: 'warn', minAgeHours: 24 },
      walls: { enabled: false, action: 'delete', lines: 12 },
    },
    // Escalation: after N automod strikes inside the window, apply an action.
    escalation: { enabled: false, strikes: 3, windowMinutes: 60, action: 'timeout', timeoutMinutes: 10 },
  },

  leveling: {
    enabled: false,
    xpPerMessage: [15, 25], // random range
    cooldownSeconds: 60,
    announce: true,
    announceChannelId: null, // null announces in the channel that triggered it
    announceMessage: 'GG {user}, you reached level **{level}**!',
    stackRewards: true,
    rewards: {}, // { "5": ["roleId"] }
    noXpChannels: [],
    noXpRoles: [],
    multipliers: {}, // { roleId: 1.5 }
    voiceXp: false,
    voiceXpPerMinute: 5,
  },

  economy: {
    enabled: false,
    currency: '🪙',
    currencyName: 'coin',
    startingBalance: 100,
    dailyAmount: [200, 400],
    weeklyAmount: [1500, 2500],
    workAmount: [80, 220],
    workCooldownMinutes: 60,
    crimeAmount: [200, 600],
    crimeFailChance: 0.45,
    crimeCooldownMinutes: 120,
    robCooldownMinutes: 180,
    robMinimumBalance: 250,
    robSuccessChance: 0.4,
    maxBet: 10_000,
    interestPercent: 0, // daily bank interest, 0 disables
    messageDrops: { enabled: false, chance: 0.02, amount: [5, 25] },
    shop: [], // extra guild-specific items appended to the built-in catalogue
  },

  starboard: {
    enabled: false,
    channelId: null,
    emoji: '⭐',
    threshold: 3,
    selfStar: false,
    ignoredChannels: [],
    ignoreBots: true,
    nsfwAllowed: false,
  },

  tickets: {
    enabled: false,
    categoryId: null,
    supportRoleIds: [],
    transcriptChannelId: null,
    openMessage: 'Thanks for opening a ticket. Describe your issue and a staff member will reply.',
    nameTemplate: 'ticket-{number}',
    maxOpenPerUser: 1,
    counter: 0,
  },

  suggestions: {
    enabled: false,
    channelId: null,
    approvedChannelId: null,
    deniedChannelId: null,
    threads: false,
    counter: 0,
  },

  counting: {
    enabled: false,
    channelId: null,
    current: 0,
    lastUserId: null,
    best: 0,
    resetOnFail: true,
    allowSameUser: false,
  },

  moderation: {
    dmOnPunish: true,
    logChannelId: null,
    muteRoleId: null,
    warnThresholds: {}, // { "3": "timeout:1h", "5": "kick", "7": "ban" }
    protectedRoles: [],
    caseCounter: 0,
    appealLink: null,
  },

  autoresponder: {
    enabled: false,
    entries: [], // { trigger, response, match: exact|contains|starts|regex, chance, deleteTrigger }
  },

  reactionRoles: {
    // messageId -> { channelId, mode, pairs: [{ emoji, roleId }] }
  },

  disabledCommands: [],
  disabledChannels: {}, // { channelId: ["commandName"] }

  stats: {
    commandsUsed: 0,
    messagesSeen: 0,
    joinedAt: 0,
  },
};

/** Deep merge of stored values over defaults. Arrays are replaced, not merged. */
function mergeDefaults(defaults, stored) {
  if (stored === undefined || stored === null) return structuredClone(defaults);
  if (Array.isArray(defaults)) return Array.isArray(stored) ? stored : structuredClone(defaults);
  if (typeof defaults !== 'object') return stored === undefined ? defaults : stored;
  if (typeof stored !== 'object' || Array.isArray(stored)) return structuredClone(defaults);

  const out = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(stored)])) {
    if (key in defaults) out[key] = mergeDefaults(defaults[key], stored[key]);
    else out[key] = stored[key]; // unknown keys are preserved, never dropped
  }
  return out;
}

/** Fresh per-member record. */
const DEFAULT_MEMBER = {
  xp: 0,
  level: 0,
  messages: 0,
  lastXpAt: 0,
  voiceMinutes: 0,
  coins: 0,
  bank: 0,
  inventory: {}, // itemId -> count
  lastDaily: 0,
  lastWeekly: 0,
  lastWork: 0,
  lastCrime: 0,
  lastRob: 0,
  dailyStreak: 0,
  bio: '',
  birthday: null,
  color: null,
  reputation: 0,
  lastRepAt: 0,
  married: null,
  badges: [],
  games: { played: 0, won: 0, lost: 0, drawn: 0 },
  gambling: { wagered: 0, won: 0, lost: 0 },
  warnPoints: 0,
  afk: null,
  todo: [],
};

/**
 * True when a member record carries nothing worth keeping.
 *
 * Records are created on first *access*, which includes read-only lookups like
 * `/balance @someone` or a leaderboard render. On a large server that quietly
 * turns members.json into a row per member the bot has ever glanced at, none of
 * which holds any data. The maintenance pass uses this to drop them.
 */
function isEmptyMember(record) {
  if (!record || typeof record !== 'object') return true;
  if (record.xp || record.messages || record.voiceMinutes) return false;
  if (record.coins || record.bank) return false;
  if (Object.keys(record.inventory || {}).length) return false;
  if (record.bio || record.birthday || record.color || record.reputation) return false;
  if (record.badges?.length || record.todo?.length) return false;
  if (record.afk || record.married || record.dailyStreak || record.counting) return false;
  if (record.games?.played || record.gambling?.wagered) return false;
  if (record.lastDaily || record.lastWeekly || record.lastWork) return false;
  // economyInitialised alone is not worth a row: it is re-derived on demand.
  return true;
}

class Database {
  /**
   * @param {{ dataDir: string, saveIntervalMs?: number, backupCount?: number, log?: object }} opts
   */
  constructor(opts) {
    const { dataDir, log } = opts;
    const storeOpts = {
      saveIntervalMs: opts.saveIntervalMs ?? 15_000,
      backupCount: opts.backupCount ?? 3,
      log,
    };
    const file = (name) => path.join(dataDir, name);

    this.log = log;
    this.stores = {
      guilds: new JsonStore(file('guilds.json'), { ...storeOpts, defaults: {} }),
      members: new JsonStore(file('members.json'), { ...storeOpts, defaults: {} }),
      cases: new JsonStore(file('cases.json'), { ...storeOpts, defaults: {} }),
      tags: new JsonStore(file('tags.json'), { ...storeOpts, defaults: {} }),
      tasks: new JsonStore(file('tasks.json'), { ...storeOpts, defaults: { seq: 0, tasks: [] } }),
      giveaways: new JsonStore(file('giveaways.json'), { ...storeOpts, defaults: {} }),
      tickets: new JsonStore(file('tickets.json'), { ...storeOpts, defaults: {} }),
      starboard: new JsonStore(file('starboard.json'), { ...storeOpts, defaults: {} }),
      global: new JsonStore(file('global.json'), {
        ...storeOpts,
        defaults: { blacklist: {}, commandUsage: {}, totals: { commands: 0, messages: 0, games: 0 }, notes: {} },
      }),
    };

    // Settings are merged on every read, which is hot on messageCreate. A tiny
    // cache keyed by guild id avoids re-merging a deep object per message; it is
    // invalidated whenever the settings are written.
    this.settingsCache = new Map();

    this.migrateLegacy(dataDir);
  }

  /**
   * The previous single-file bot stored warnings in warns.json at the project
   * root. Import them once so upgrading does not lose moderation history.
   */
  migrateLegacy(dataDir) {
    try {
      const fs = require('node:fs');
      const legacy = path.join(path.dirname(dataDir), 'warns.json');
      if (!fs.existsSync(legacy)) return;
      const marker = this.stores.global.get('migrations.warnsJson', false);
      if (marker) return;

      const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      let imported = 0;
      for (const [guildId, users] of Object.entries(raw || {})) {
        for (const [userId, entries] of Object.entries(users || {})) {
          for (const entry of entries || []) {
            this.addCase(guildId, {
              type: 'warn',
              userId,
              moderatorId: null,
              moderatorTag: entry.by || 'unknown',
              reason: entry.reason || 'No reason recorded',
              at: entry.at || Date.now(),
              imported: true,
            });
            imported++;
          }
        }
      }
      this.stores.global.set('migrations.warnsJson', true);
      if (imported) this.log?.info(`imported ${imported} warning(s) from the old warns.json`);
    } catch (e) {
      this.log?.warn(`legacy warns.json import skipped: ${e.message}`);
    }
  }

  // ---------- guild settings ----------

  /** Returns merged, read-only-ish settings for a guild. */
  settings(guildId) {
    const cached = this.settingsCache.get(guildId);
    if (cached) return cached;
    const merged = mergeDefaults(DEFAULT_GUILD, this.stores.guilds.get(guildId));
    this.settingsCache.set(guildId, merged);
    return merged;
  }

  /**
   * Updates a dotted settings path, e.g. setSetting(id, 'welcome.enabled', true).
   * Only the changed path is persisted; defaults stay implicit.
   */
  setSetting(guildId, dotted, value) {
    this.stores.guilds.set(`${guildId}.${dotted}`, value);
    this.settingsCache.delete(guildId);
    return value;
  }

  /** Applies several dotted updates at once. */
  patchSettings(guildId, patch) {
    for (const [k, v] of Object.entries(patch)) this.stores.guilds.set(`${guildId}.${k}`, v);
    this.settingsCache.delete(guildId);
  }

  /** Removes a dotted settings path so it falls back to the default. */
  resetSetting(guildId, dotted) {
    const ok = this.stores.guilds.delete(`${guildId}.${dotted}`);
    this.settingsCache.delete(guildId);
    return ok;
  }

  /** Wipes every stored setting for a guild. */
  resetGuild(guildId) {
    this.stores.guilds.delete(guildId);
    this.settingsCache.delete(guildId);
  }

  /** Raw stored (non-merged) settings, used by /config export. */
  rawSettings(guildId) {
    return this.stores.guilds.get(guildId, {});
  }

  /** Replaces the stored settings wholesale, used by /config import. */
  replaceSettings(guildId, obj) {
    this.stores.guilds.set(guildId, obj);
    this.settingsCache.delete(guildId);
  }

  // ---------- member records ----------

  /** Live per-member record, created on first access. */
  member(guildId, userId) {
    const key = `${guildId}.${userId}`;
    const existing = this.stores.members.get(key);
    if (existing) {
      // Fill in fields added by later versions without rewriting the file.
      for (const [k, v] of Object.entries(DEFAULT_MEMBER)) {
        if (!(k in existing)) existing[k] = structuredClone(v);
      }
      return existing;
    }
    const created = structuredClone(DEFAULT_MEMBER);
    this.stores.members.set(key, created);
    return created;
  }

  /** Persists changes made to a record returned by member(). */
  saveMember() {
    this.stores.members.touch();
  }

  /** Every member record of a guild as [userId, record] pairs. */
  members(guildId) {
    return Object.entries(this.stores.members.get(guildId, {}));
  }

  /** Deletes one member record. */
  deleteMember(guildId, userId) {
    return this.stores.members.delete(`${guildId}.${userId}`);
  }

  /**
   * Sorted leaderboard for a guild.
   * @param {string} guildId
   * @param {(rec: object) => number} score
   * @param {number} [limit]
   */
  leaderboard(guildId, score, limit = 100) {
    return this.members(guildId)
      .map(([userId, rec]) => ({ userId, rec, score: score(rec) || 0 }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------- moderation cases ----------

  /** Appends a moderation case and returns it, with its per-guild case number. */
  addCase(guildId, entry) {
    const bucket = this.stores.cases.ensure(guildId, { seq: 0, list: [] });
    bucket.seq = (bucket.seq || 0) + 1;
    const record = {
      id: bucket.seq,
      at: Date.now(),
      ...entry,
    };
    bucket.list.push(record);
    // Keeping every case forever would grow without bound on a busy server.
    if (bucket.list.length > 5000) bucket.list.splice(0, bucket.list.length - 5000);
    this.stores.cases.touch();
    return record;
  }

  /** All cases for a guild, newest last. */
  cases(guildId) {
    return this.stores.cases.get(`${guildId}.list`, []);
  }

  /** One case by its per-guild number. */
  getCase(guildId, id) {
    return this.cases(guildId).find((c) => c.id === Number(id)) || null;
  }

  /** Cases filed against one user. */
  casesFor(guildId, userId, type = null) {
    return this.cases(guildId).filter((c) => c.userId === userId && (!type || c.type === type));
  }

  /** Edits a case in place, e.g. to change its reason. */
  updateCase(guildId, id, patch) {
    const c = this.getCase(guildId, id);
    if (!c) return null;
    Object.assign(c, patch);
    this.stores.cases.touch();
    return c;
  }

  /** Removes a case. Returns true when one was removed. */
  deleteCase(guildId, id) {
    const bucket = this.stores.cases.get(guildId);
    if (!bucket?.list) return false;
    const idx = bucket.list.findIndex((c) => c.id === Number(id));
    if (idx === -1) return false;
    bucket.list.splice(idx, 1);
    this.stores.cases.touch();
    return true;
  }

  /** Drops every case for a user, returning how many were removed. */
  clearCases(guildId, userId, type = null) {
    const bucket = this.stores.cases.get(guildId);
    if (!bucket?.list) return 0;
    const before = bucket.list.length;
    bucket.list = bucket.list.filter((c) => c.userId !== userId || (type && c.type !== type));
    this.stores.cases.touch();
    return before - bucket.list.length;
  }

  // ---------- tags ----------

  tag(guildId, name) {
    return this.stores.tags.get(`${guildId}.${String(name).toLowerCase()}`, null);
  }

  setTag(guildId, name, value) {
    return this.stores.tags.set(`${guildId}.${String(name).toLowerCase()}`, value);
  }

  deleteTag(guildId, name) {
    return this.stores.tags.delete(`${guildId}.${String(name).toLowerCase()}`);
  }

  tags(guildId) {
    return Object.entries(this.stores.tags.get(guildId, {}));
  }

  // ---------- global ----------

  /** Records a command execution for /stats. */
  recordCommand(name) {
    this.stores.global.add(`commandUsage.${name}`, 1);
    this.stores.global.add('totals.commands', 1);
  }

  /** True when a user is blocked from using the bot everywhere. */
  isBlacklisted(userId) {
    return Boolean(this.stores.global.get(`blacklist.${userId}`));
  }

  blacklist(userId, reason, by) {
    this.stores.global.set(`blacklist.${userId}`, { reason, by, at: Date.now() });
  }

  unblacklist(userId) {
    return this.stores.global.delete(`blacklist.${userId}`);
  }

  // ---------- lifecycle ----------

  /** Writes every dirty store. */
  flushAll(force = false) {
    let written = 0;
    for (const store of Object.values(this.stores)) if (store.flush(force)) written++;
    return written;
  }

  /** Rotates backups for every store. */
  backupAll() {
    for (const store of Object.values(this.stores)) store.backup();
  }

  /** Final flush on shutdown. */
  close() {
    for (const store of Object.values(this.stores)) store.close();
  }

  /** Per-store diagnostics for /stats storage. */
  stats() {
    return Object.entries(this.stores).map(([name, store]) => ({ name, ...store.stats() }));
  }
}

module.exports = { Database, DEFAULT_GUILD, DEFAULT_MEMBER, mergeDefaults, isEmptyMember };
