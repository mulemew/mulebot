'use strict';

const os = require('node:os');

/**
 * Cache and sweeper profiles.
 *
 * Measured baseline: an idle bot with no guilds sits at ~86 MB RSS, of which
 * ~45 MB is discord.js itself and ~37 MB is the Node runtime. Only ~3 MB is
 * this bot's own code, features, games and commands. So on a small host the
 * thing to control is not our code - it is what discord.js keeps in memory
 * once guilds start arriving.
 *
 * Two discord.js defaults matter:
 *
 *   makeCache  = { MessageManager: 200 }   ← 200 messages *per channel*
 *   sweepers   = { threads: ... }          ← nothing else is ever swept
 *
 * A server with 40 active channels therefore caches 8,000 messages that are
 * never evicted, and every user, member and voice state the bot has ever seen
 * accumulates for the life of the process. That is the growth people notice as
 * "the bot slowly eats all the RAM".
 *
 * These profiles cap the caches and turn on sweepers. The trade-off is real and
 * is documented per profile: a smaller message cache means more message-delete
 * events arrive as partials, which the logger skips because there is nothing
 * useful to report.
 *
 * Managers deliberately never limited, because discord.js depends on them being
 * complete: GuildManager, ChannelManager, GuildChannelManager, RoleManager,
 * PermissionOverwriteManager.
 */

const PROFILES = {
  /** For a 256-512 MB host. Aggressive, with visible trade-offs. */
  low: {
    label: 'low',
    description: 'for hosts with under ~512 MB of RAM',
    cache: {
      MessageManager: 25,
      UserManager: 100,
      GuildMemberManager: 50,
      PresenceManager: 0,
      ThreadManager: 20,
      ThreadMemberManager: 0,
      GuildInviteManager: 0,
      GuildBanManager: 0,
      GuildScheduledEventManager: 0,
      AutoModerationRuleManager: 0,
      StageInstanceManager: 0,
      ReactionUserManager: 0,
      GuildForumThreadManager: 10,
      GuildTextThreadManager: 10,
    },
    sweep: {
      messages: { interval: 300, lifetime: 600 },
      users: { interval: 900 },
      guildMembers: { interval: 900 },
      threads: { interval: 1800, lifetime: 3600 },
      reactions: { interval: 600 },
      invites: { interval: 1800, lifetime: 1800 },
      bans: { interval: 3600 },
      stageInstances: { interval: 3600, lifetime: 3600 },
      voiceStates: { interval: 1800 },
    },
    // How often our own maintenance pass runs, and how hard it prunes.
    maintenanceHours: 6,
    memberIdleDays: 90,
    tradeoffs: [
      'message deletes and edits older than ~10 minutes arrive as partials and are not logged',
      'the /snipe buffer is unaffected (it keeps its own copy)',
      'join-position in /userinfo counts fewer cached members',
    ],
  },

  /** The default. Sensible caps, sweepers on. */
  balanced: {
    label: 'balanced',
    description: 'for hosts with roughly 512 MB to 2 GB',
    cache: {
      MessageManager: 100,
      UserManager: 500,
      GuildMemberManager: 300,
      PresenceManager: 0,
      ThreadManager: 50,
      ThreadMemberManager: 0,
      GuildInviteManager: 0,
      GuildBanManager: 0,
      GuildScheduledEventManager: 10,
      AutoModerationRuleManager: 0,
      StageInstanceManager: 5,
      ReactionUserManager: 20,
    },
    sweep: {
      messages: { interval: 600, lifetime: 1800 },
      users: { interval: 3600 },
      guildMembers: { interval: 3600 },
      threads: { interval: 3600, lifetime: 14400 },
      reactions: { interval: 1800 },
      invites: { interval: 3600, lifetime: 3600 },
      voiceStates: { interval: 3600 },
    },
    maintenanceHours: 12,
    memberIdleDays: 180,
    tradeoffs: ['message deletes older than ~30 minutes arrive as partials and are not logged'],
  },

  /** For a host with room to spare; closest to discord.js defaults. */
  high: {
    label: 'high',
    description: 'for hosts with 2 GB or more',
    cache: {
      MessageManager: 400,
      PresenceManager: 0,
    },
    sweep: {
      messages: { interval: 1800, lifetime: 7200 },
      threads: { interval: 3600, lifetime: 14400 },
    },
    maintenanceHours: 24,
    memberIdleDays: 0, // never prune member records
    tradeoffs: [],
  },
};

/** Managers that break things if limited, per the discord.js docs. */
const NEVER_LIMIT = new Set([
  'GuildManager',
  'ChannelManager',
  'GuildChannelManager',
  'RoleManager',
  'PermissionOverwriteManager',
]);

/** Keeps the bot's own user/member in cache no matter what the limit is. */
const keepSelf = (entity) => {
  try {
    return entity.id === entity.client?.user?.id;
  } catch {
    return false;
  }
};

/**
 * The only sweepers that evict by age. Every other sweeper key requires a
 * filter function, and discord.js throws at client construction if one is
 * missing - so this distinction is load-bearing, not cosmetic.
 */
const LIFETIME_SWEEPERS = new Set(['messages', 'threads', 'invites']);

/**
 * Per-sweeper filters. A filter returns a function, or null to skip the sweep
 * entirely on this pass.
 */
const FILTERS = {
  // Never evict the bot's own user or member object: guild.members.me returning
  // null breaks every permission check in the codebase.
  users: () => (user) => !keepSelf(user),
  guildMembers: () => (member) => !keepSelf(member),
  // A voice state with no channel is a leftover; one with a channel is live and
  // the voice XP tracker still needs it.
  voiceStates: () => (state) => !state.channelId,
  // Reactions and bans are re-fetched on demand, so they are safe to drop whole.
  reactions: () => () => true,
  bans: () => () => true,
  stageInstances: () => () => true,
  applicationCommands: () => () => true,
  autoModerationRules: () => () => true,
  emojis: () => () => false, // small, and /emoji reads them
  presences: () => () => true,
  guildScheduledEvents: () => () => true,
  stickers: () => () => false,
  threadMembers: () => () => true,
};

/**
 * Chooses a profile when none was configured, from total system memory.
 * A container's limit is not visible through os.totalmem(), so cgroup limits
 * are read directly - otherwise a 256 MB container on a 24 GB host would pick
 * the "high" profile and get itself OOM-killed.
 */
function detectProfile() {
  const limitMb = containerMemoryLimitMb() ?? Math.round(os.totalmem() / 1024 / 1024);
  if (limitMb <= 512) return 'low';
  if (limitMb <= 2048) return 'balanced';
  return 'high';
}

/**
 * Reads the cgroup memory limit, v2 then v1. Returns null when unlimited or
 * unreadable (any non-Linux host, for a start).
 */
function containerMemoryLimitMb() {
  const fs = require('node:fs');
  const candidates = [
    '/sys/fs/cgroup/memory.max', // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') return null;
      const bytes = Number(raw);
      // v1 reports a nonsense huge number when unlimited.
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 ** 4) continue;
      return Math.round(bytes / 1024 / 1024);
    } catch {
      /* not present on this host */
    }
  }
  return null;
}

/**
 * Builds the client options fragment for a profile.
 * @param {import('discord.js')} discord
 * @param {string} name profile name, or 'auto'
 */
function build(discord, name = 'auto') {
  const { Options } = discord;
  const chosen = name === 'auto' || !PROFILES[name] ? detectProfile() : name;
  const profile = PROFILES[chosen];

  const limits = { ...Options.DefaultMakeCacheSettings };
  for (const [manager, value] of Object.entries(profile.cache)) {
    if (NEVER_LIMIT.has(manager)) continue;

    // A bare number is a plain cap. The managers that hold the bot's own
    // identity need keepOverLimit, or the client can evict itself and then
    // guild.members.me starts returning null.
    if (manager === 'UserManager' || manager === 'GuildMemberManager') {
      limits[manager] = { maxSize: value, keepOverLimit: keepSelf };
    } else {
      limits[manager] = value;
    }
  }

  const sweepers = { ...Options.DefaultSweeperSettings };
  for (const [key, settings] of Object.entries(profile.sweep)) {
    // Only these three accept a lifetime; every other sweeper requires an
    // explicit filter function and throws at construction time without one.
    if (LIFETIME_SWEEPERS.has(key) && settings.lifetime !== undefined) {
      sweepers[key] = { interval: settings.interval, lifetime: settings.lifetime };
      continue;
    }

    const filter = FILTERS[key] || (() => () => true);
    sweepers[key] = { interval: settings.interval, filter };
  }

  return {
    profile: chosen,
    meta: profile,
    detectedLimitMb: containerMemoryLimitMb(),
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    options: {
      makeCache: Options.cacheWithLimits(limits),
      sweepers,
    },
  };
}

/** Current size of every cache, for diagnostics. */
function snapshot(client) {
  if (!client?.guilds) return {};
  let members = 0;
  let channels = 0;
  let messages = 0;
  let voiceStates = 0;
  let roles = 0;
  let emojis = 0;

  for (const guild of client.guilds.cache.values()) {
    members += guild.members.cache.size;
    roles += guild.roles.cache.size;
    emojis += guild.emojis.cache.size;
    voiceStates += guild.voiceStates.cache.size;
    for (const channel of guild.channels.cache.values()) {
      channels++;
      if (channel.messages) messages += channel.messages.cache.size;
    }
  }

  return {
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
    channels,
    members,
    messages,
    roles,
    emojis,
    voiceStates,
  };
}

module.exports = { build, snapshot, detectProfile, containerMemoryLimitMb, PROFILES };
