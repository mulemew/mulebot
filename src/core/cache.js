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
 * Reads the cgroup memory limit and the usage charged against it, v2 then v1.
 * Both are null when unlimited or unreadable, which covers every non-Linux host.
 */
function cgroupMemory({ root = '/sys/fs/cgroup', selfCgroup = '/proc/self/cgroup' } = {}) {
  const fs = require('node:fs');

  const readLimit = (file) => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null; // absent, which is the normal case for most of these paths
    }
    if (raw === 'max') return null;
    const bytes = Number(raw);
    // cgroup v1 reports a nonsense huge number rather than a word when
    // unlimited, so anything past a terabyte means "no limit" too.
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 ** 4) return null;
    return bytes;
  };

  const readUsage = (file) => {
    try {
      const bytes = Number(fs.readFileSync(file, 'utf8').trim());
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    } catch {
      return null;
    }
  };

  // Every cgroup directory this process belongs to, leaf first.
  //
  // A container gets its own cgroup namespace, so its limit sits at the root of
  // what it can see. A systemd service does not: it lives at
  // /system.slice/<unit>, and reading the root there answers for the whole
  // machine - which is why MemoryMax= used to go unnoticed entirely.
  const dirs = [
    { dir: root, limit: 'memory.max', usage: 'memory.current' },
    { dir: `${root}/memory`, limit: 'memory.limit_in_bytes', usage: 'memory.usage_in_bytes' },
  ];

  try {
    for (const line of fs.readFileSync(selfCgroup, 'utf8').split('\n')) {
      // v2: "0::/system.slice/bot.service"   v1: "9:memory:/system.slice/..."
      const parts = line.split(':');
      if (parts.length < 3) continue;
      const controller = parts[1];
      const cgPath = parts.slice(2).join(':');
      if (!cgPath || cgPath === '/') continue;
      if (controller !== '' && !controller.split(',').includes('memory')) continue;

      // Leaf to root: a limit can be set on any ancestor, and the one that
      // actually binds is the smallest, so every level has to be considered.
      const segments = cgPath.split('/').filter(Boolean);
      for (let i = segments.length; i > 0; i--) {
        const prefix = segments.slice(0, i).join('/');
        if (controller === '') dirs.push({ dir: `${root}/${prefix}`, limit: 'memory.max', usage: 'memory.current' });
        else dirs.push({ dir: `${root}/memory/${prefix}`, limit: 'memory.limit_in_bytes', usage: 'memory.usage_in_bytes' });
      }
    }
  } catch {
    /* no /proc, e.g. not Linux */
  }

  // The binding limit is the tightest one, and the usage that matters is the
  // usage of that same cgroup: read the pair together rather than the smallest
  // limit from one place and whatever usage happened to be readable elsewhere.
  let binding = null;
  for (const candidate of dirs) {
    const bytes = readLimit(`${candidate.dir}/${candidate.limit}`);
    if (bytes === null) continue;
    if (!binding || bytes < binding.bytes) binding = { bytes, dir: candidate.dir, usage: candidate.usage };
  }

  if (binding) {
    const used = readUsage(`${binding.dir}/${binding.usage}`);
    return {
      limitMb: Math.round(binding.bytes / 1024 / 1024),
      usedMb: used === null ? null : Math.round(used / 1024 / 1024),
    };
  }

  // No limit anywhere. Usage from the most specific cgroup is still worth
  // reporting where it exists; on a plain VPS there is nothing to read.
  for (const candidate of dirs) {
    const used = readUsage(`${candidate.dir}/${candidate.usage}`);
    if (used !== null) return { limitMb: null, usedMb: Math.round(used / 1024 / 1024) };
  }
  return { limitMb: null, usedMb: null };
}

/**
 * The memory limit this process is actually held to, in MB, or null.
 * Thin wrapper: most callers only want the limit.
 */
function containerMemoryLimitMb(options) {
  return cgroupMemory(options).limitMb;
}

/**
 * What the kernel counts against that limit, in MB, or null.
 *
 * This is not the same number as process.memoryUsage().rss, and the difference
 * is the whole point: the cgroup is charged for every process in the container,
 * for tmpfs files (which /tmp usually is on a read-only host), and for page
 * cache. A bot reporting 119 MB of RSS can be sitting in a container the kernel
 * considers 250 MB full, and the OOM killer goes by the second number.
 */
function containerMemoryUsedMb(options) {
  return cgroupMemory(options).usedMb;
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

module.exports = {
  build,
  snapshot,
  detectProfile,
  containerMemoryLimitMb,
  containerMemoryUsedMb,
  cgroupMemory,
  PROFILES,
};
