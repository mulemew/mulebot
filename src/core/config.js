'use strict';

const path = require('node:path');

/**
 * Process-level configuration, read once from the environment.
 *
 * Per-guild settings do NOT live here - those are stored in data/guilds.json and
 * edited at runtime through /config. This module only covers things that must be
 * known before the bot can talk to Discord at all, plus operational knobs an
 * operator sets on the host.
 */

/** Parses "true/1/yes/on" (case-insensitive) as true. Anything else is false. */
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on|y)$/i.test(String(value).trim());
}

/** Parses an integer with a fallback and optional clamping. */
function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Splits a comma or space separated list into trimmed, non-empty entries. */
function list(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Turns a list of user IDs into snowflakes, discarding what cannot be one.
 *
 * Every wrong shape fails the same silent way: the id matches nobody, so owner
 * commands refuse the very person who configured them - and because the bot
 * still counts itself as having an owner, it cannot tell them anything is
 * wrong. The shapes that actually turn up are quotes copied out of a config
 * file and the `<@123>` form left behind by copying a mention. A server or
 * channel ID pasted by mistake survives this, since every Discord ID is the
 * same shape; that one is only visible by comparing it with your own.
 */
function snowflakes(value) {
  const kept = [];
  const rejected = [];
  for (const entry of list(value)) {
    const cleaned = entry.replace(/^["']|["']$/g, '').replace(/^<@!?(\d+)>$/, '$1');
    if (/^\d{17,20}$/.test(cleaned)) kept.push(cleaned);
    else rejected.push(entry);
  }
  return { kept, rejected };
}

/**
 * Builds the frozen config object.
 * @param {{ rootDir: string, token: string }} opts
 */
function loadConfig({ rootDir, token }) {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(rootDir, process.env.DATA_DIR)
    : path.join(rootDir, 'data');

  // Plugins are state, not source. They are installed, replaced and deleted
  // while the bot runs, so they belong with everything else that has to survive
  // a restart - which is why there is no PLUGINS_DIR: point DATA_DIR somewhere
  // persistent and the plugins go with it, one volume for the lot.
  const pluginsDir = path.join(dataDir, 'plugins');

  // Where the plugins that ship with the bot are copied from, the first time
  // the directory above is created. After that they are ordinary files that
  // can be edited or deleted like any other.
  const builtinPluginsDir = path.join(rootDir, 'plugins');

  const ownerIds = snowflakes(process.env.OWNER_IDS || process.env.OWNER_ID);

  const cfg = {
    token,
    rootDir,
    dataDir,
    pluginsDir,
    builtinPluginsDir,

    // Plugins run with the full privileges of this process - loading one is as
    // consequential as editing the bot's source. Set PLUGINS_ENABLED=false on a
    // host where the plugins directory is not exclusively yours.
    pluginsEnabled: bool(process.env.PLUGINS_ENABLED, true),
    // Auto-reload on file change. Off by default: an editor that writes a file
    // in two chunks would otherwise reload a half-written plugin.
    pluginWatch: bool(process.env.PLUGIN_WATCH, false),
    // Run 'npm install' for a directory plugin that declares dependencies.
    // Off by default: npm needs well over 100 MB, which on a 256 MB host is
    // enough to get the container OOM-killed during startup.
    pluginAutoInstall: bool(process.env.PLUGIN_AUTO_INSTALL, false),

    // Registering to a single guild applies instantly; global registration can
    // take up to an hour to propagate through Discord's cache.
    guildId: (process.env.GUILD_ID || '').trim(),

    // Owners bypass cooldowns and can use /owner commands. Comma separated IDs.
    owners: ownerIds.kept,
    ownersRejected: ownerIds.rejected,

    // Default locale for guilds that never ran /config language.
    defaultLocale: (process.env.BOT_LANG || 'en').trim(),

    // Legacy text-command prefix. Needs the MESSAGE CONTENT privileged intent;
    // when that intent is unavailable the prefix bridge disables itself.
    defaultPrefix: (process.env.PREFIX || '!').trim(),

    // Fallback welcome channel resolution for guilds with nothing configured.
    welcomeChannel: (process.env.WELCOME_CHANNEL || '').trim(),

    // Presence shown in the member list.
    activity: (process.env.ACTIVITY || '/help').trim(),
    activityType: (process.env.ACTIVITY_TYPE || 'Playing').trim(),
    status: (process.env.STATUS || 'online').trim(),

    // Visual identity used by every embed.
    color: int(process.env.EMBED_COLOR, 0x5865f2, { min: 0, max: 0xffffff }),
    colorSuccess: int(process.env.EMBED_COLOR_OK, 0x57f287, { min: 0, max: 0xffffff }),
    colorWarn: int(process.env.EMBED_COLOR_WARN, 0xfee75c, { min: 0, max: 0xffffff }),
    colorError: int(process.env.EMBED_COLOR_ERROR, 0xed4245, { min: 0, max: 0xffffff }),

    // Operational knobs.
    logLevel: (process.env.LOG_LEVEL || 'info').trim(),

    // Optional rotating log file. stdout is always written regardless; this is
    // for hosts where nothing captures stdout. Total disk use is bounded by
    // maxBytes * (keep + 1).
    logFile: (process.env.LOG_FILE || '').trim(),
    logFileMaxBytes: int(process.env.LOG_FILE_MAX_BYTES, 1024 * 1024, { min: 64 * 1024, max: 256 * 1024 * 1024 }),
    logFileKeep: int(process.env.LOG_FILE_KEEP, 4, { min: 0, max: 50 }),

    // low | balanced | high | auto. Controls discord.js cache limits and
    // sweepers, which dominate memory once guilds are connected.
    memoryProfile: (process.env.MEMORY_PROFILE || 'auto').trim(),

    saveIntervalMs: int(process.env.SAVE_INTERVAL, 15_000, { min: 1_000, max: 600_000 }),
    backupCount: int(process.env.BACKUP_COUNT, 3, { min: 0, max: 20 }),
    schedulerTickMs: int(process.env.SCHEDULER_TICK, 5_000, { min: 500, max: 60_000 }),

    // Feature master switches. A guild can still disable a feature locally, but
    // switching it off here removes it everywhere including its commands.
    features: {
      leveling: bool(process.env.FEATURE_LEVELING, true),
      economy: bool(process.env.FEATURE_ECONOMY, true),
      automod: bool(process.env.FEATURE_AUTOMOD, true),
      games: bool(process.env.FEATURE_GAMES, true),
      tickets: bool(process.env.FEATURE_TICKETS, true),
      giveaways: bool(process.env.FEATURE_GIVEAWAYS, true),
      starboard: bool(process.env.FEATURE_STARBOARD, true),
      logging: bool(process.env.FEATURE_LOGGING, true),
      suggestions: bool(process.env.FEATURE_SUGGESTIONS, true),
      counting: bool(process.env.FEATURE_COUNTING, true),
      prefixCommands: bool(process.env.FEATURE_PREFIX, true),
    },

    // Command registration can be skipped when iterating locally to avoid
    // burning through the daily registration rate limit.
    registerCommands: bool(process.env.REGISTER_COMMANDS, true),
    // Removes every registered command and exits. Useful when retiring a bot.
    clearCommands: bool(process.env.CLEAR_COMMANDS, false),
  };

  return Object.freeze(cfg);
}

module.exports = { loadConfig, bool, int, list };
