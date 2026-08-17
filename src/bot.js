'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Logger, buffer: logBuffer, configureFile, fileStats } = require('./core/logger');
const cacheProfiles = require('./core/cache');
const { loadConfig } = require('./core/config');
const { Database } = require('./core/db');
const { Scheduler } = require('./core/scheduler');
const { Registry, ComponentRouter } = require('./core/registry');
const { CooldownManager } = require('./core/cooldowns');
const { PluginHost } = require('./core/plugins');
const { Paginator } = require('./util/pager');
const i18n = require('./core/i18n');
const embeds = require('./util/embeds');

/**
 * The Bot object owns every subsystem and is passed to commands, features and
 * event handlers as the single point of access. Nothing reaches for a global.
 *
 * Startup order matters and is enforced here:
 *   config -> logger -> database -> scheduler -> registry -> features ->
 *   client -> events -> login
 *
 * Features are constructed before the client exists on purpose: a feature may
 * need to register scheduler handlers and component routes, and doing that
 * before the gateway connects removes a race where an interaction arrives
 * before its route is in place.
 */
class Bot {
  constructor({ token, rootDir, discord }) {
    this.discord = discord;
    this.config = loadConfig({ rootDir, token });
    this.log = new Logger('bot', { level: this.config.logLevel });
    this.startedAt = Date.now();
    this.readyAt = 0;

    this.client = null;
    this.db = null;
    this.scheduler = null;
    this.registry = null;
    this.components = null;
    this.cooldowns = null;
    this.paginator = null;
    this.plugins = null;
    this.features = {};

    /** Which privileged intents actually made it through login. */
    this.intents = { members: false, messageContent: false, presence: false };

    this.counters = { commands: 0, interactions: 0, messages: 0, errors: 0 };
  }

  // ---------- construction ----------

  async init() {
    fs.mkdirSync(this.config.dataDir, { recursive: true });

    // Optional rotating log file. stdout stays the primary sink either way.
    if (this.config.logFile) {
      configureFile({
        file: path.resolve(this.config.rootDir, this.config.logFile),
        maxBytes: this.config.logFileMaxBytes,
        keep: this.config.logFileKeep,
      });
      this.log.info(
        `logging to ${this.config.logFile} ` +
          `(rotating at ${Math.round(this.config.logFileMaxBytes / 1024)}kb, keeping ${this.config.logFileKeep})`,
      );
    }

    // Decide the cache profile before the client is built - makeCache and the
    // sweepers are fixed at construction time.
    this.cacheProfile = cacheProfiles.build(this.discord, this.config.memoryProfile);
    this.reportMemoryBudget();

    embeds.configure({
      primary: this.config.color,
      success: this.config.colorSuccess,
      warning: this.config.colorWarn,
      danger: this.config.colorError,
    });

    this.db = new Database({
      dataDir: this.config.dataDir,
      saveIntervalMs: this.config.saveIntervalMs,
      backupCount: this.config.backupCount,
      log: this.log.child('db'),
    });

    this.scheduler = new Scheduler({
      store: this.db.stores.tasks,
      log: this.log.child('scheduler'),
      tickMs: this.config.schedulerTickMs,
    });

    this.cooldowns = new CooldownManager({ log: this.log.child('cooldown') });
    this.components = new ComponentRouter({ log: this.log.child('components') });
    this.paginator = new Paginator({ log: this.log.child('pager') }).attach(this.components);

    this.registry = new Registry({ log: this.log.child('commands'), config: this.config });
    const count = this.registry.load(path.join(__dirname, 'commands'));
    this.log.info(`loaded ${count} command(s) from ${this.registry.loadedFiles} file(s)`);
    if (this.registry.failures.length) {
      this.log.warn(`${this.registry.failures.length} command file(s) failed to load - see errors above`);
    }

    this.loadFeatures();

    // A command may need to register a component route (a paginated /help menu,
    // a confirmation button). setup() runs after features exist so a command can
    // reach for them, and before the gateway connects so no interaction can
    // arrive before its route is in place.
    for (const command of this.registry.all()) {
      if (typeof command.setup !== 'function') continue;
      try {
        command.setup(this);
      } catch (e) {
        this.log.error(`setup() for /${command.data.name} failed:`, e);
      }
    }

    this.buildClient(true, true);
    this.loadEvents();

    // Plugins load last, once the client object exists, so a plugin can attach
    // gateway listeners in its init(). They are loaded before login, so any
    // command they register is included in the registration that clientReady
    // performs.
    this.plugins = new PluginHost(this, {
      dir: this.config.pluginsDir,
      log: this.log.child('plugins'),
    });
    if (this.config.pluginsEnabled) {
      await this.plugins.loadAll();
      if (this.config.pluginWatch) this.plugins.startWatching();
      // Memory-mode plugins leave nothing on disk, so they are fetched again
      // from the URL they came from.
      await this.plugins.restoreRemotes();
    } else {
      this.log.info('plugins are disabled by PLUGINS_ENABLED=false');
    }

    // Periodic housekeeping: flush dirty stores and rotate backups. The flush
    // interval is short because losing 15 seconds of economy activity to a
    // crash is acceptable, losing an hour is not.
    this.saveTimer = setInterval(() => this.db.flushAll(), this.config.saveIntervalMs);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();

    this.backupTimer = setInterval(() => this.db.backupAll(), 6 * 60 * 60 * 1000);
    if (typeof this.backupTimer.unref === 'function') this.backupTimer.unref();

    this.scheduler.start();
    this.log.info('initialisation complete');
  }

  /** Instantiates every feature module under src/features. */
  loadFeatures() {
    const dir = path.join(__dirname, 'features');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
    } catch {
      this.log.warn('no features directory found');
      return;
    }

    for (const file of files) {
      const name = file.replace(/\.js$/, '');
      try {
        const mod = require(path.join(dir, file));
        if (typeof mod.init !== 'function') {
          this.log.warn(`feature ${name} has no init(), skipping`);
          continue;
        }
        this.features[mod.name || name] = mod.init(this) || {};
        this.log.debug(`feature ${name} ready`);
      } catch (e) {
        this.log.error(`feature ${name} failed to initialise:`, e);
      }
    }
    this.log.info(`initialised ${Object.keys(this.features).length} feature(s)`);
  }

  /**
   * Builds the gateway client.
   * @param {boolean} withMembers request the GUILD_MEMBERS privileged intent
   * @param {boolean} withContent request the MESSAGE_CONTENT privileged intent
   */
  buildClient(withMembers, withContent) {
    const { Client, GatewayIntentBits: I, Partials } = this.discord;

    const intents = [
      I.Guilds,
      I.GuildMessages,
      I.GuildMessageReactions,
      I.GuildVoiceStates,
      I.GuildModeration,
      I.DirectMessages,
    ];
    if (withMembers) intents.push(I.GuildMembers);
    if (withContent) intents.push(I.MessageContent);

    this.intents.members = withMembers;
    this.intents.messageContent = withContent;

    this.client = new Client({
      intents,
      // Cache limits and sweepers from the memory profile. Without these,
      // discord.js caches 200 messages per channel forever and never evicts a
      // user, member or voice state - which is what makes a long-running bot
      // slowly consume all available memory.
      ...(this.cacheProfile?.options || {}),
      // Partials matter for reaction handling: without them, a reaction on a
      // message that predates the current process is silently dropped, which
      // breaks starboard and reaction roles after every restart.
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
      allowedMentions: { parse: ['users'], repliedUser: false },
      failIfNotExists: false,
    });
    this.client.bot = this;
    return this.client;
  }

  /** Attaches every event module under src/events to the current client. */
  loadEvents() {
    const dir = path.join(__dirname, 'events');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
    } catch {
      this.log.warn('no events directory found');
      return;
    }

    let attached = 0;
    for (const file of files) {
      try {
        const mod = require(path.join(dir, file));
        const list = Array.isArray(mod) ? mod : [mod];
        for (const handler of list) {
          if (!handler?.name || typeof handler.execute !== 'function') continue;
          const wrapped = (...args) =>
            Promise.resolve(handler.execute(this, ...args)).catch((e) => {
              this.counters.errors++;
              this.log.error(`event ${handler.name} threw:`, e);
            });
          if (handler.once) this.client.once(handler.name, wrapped);
          else this.client.on(handler.name, wrapped);
          attached++;
        }
      } catch (e) {
        this.log.error(`event file ${file} failed to load:`, e);
      }
    }
    this.log.info(`attached ${attached} event handler(s)`);
  }

  // ---------- login ----------

  /**
   * Logs in, walking down a ladder of intent sets when Discord rejects a
   * privileged one. Each downgrade is reported with the exact feature it costs
   * and the exact switch that would restore it - a checkbox in the developer
   * portal should not silently disable half the bot.
   */
  async login() {
    const ladder = [
      { members: true, content: true, note: null },
      {
        members: true,
        content: false,
        note: 'MESSAGE CONTENT INTENT is off: prefix commands, automod and level XP from messages are disabled.',
      },
      {
        members: false,
        content: true,
        note: 'SERVER MEMBERS INTENT is off: welcome messages, autorole and member logging are disabled.',
      },
      {
        members: false,
        content: false,
        note: 'Both privileged intents are off: slash commands work, message-driven features do not.',
      },
    ];

    let lastError = null;
    for (const [index, tier] of ladder.entries()) {
      if (index > 0) {
        // Rebuild from scratch: intents are fixed at construction time.
        try {
          await this.client.destroy();
        } catch {
          /* destroying a client that never connected is fine */
        }
        this.buildClient(tier.members, tier.content);
        this.loadEvents();

        // Plugin listeners were attached to the client that has just been
        // thrown away, so reload them onto the new one. Without this a plugin
        // silently stops receiving events whenever an intent downgrade happens.
        if (this.plugins && this.config.pluginsEnabled) await this.plugins.reloadAll();
      }

      try {
        await this.client.login(this.config.token);
        if (tier.note) {
          this.log.warn(tier.note);
          this.log.warn('Enable it at https://discord.com/developers/applications -> your app');
          this.log.warn('-> Bot -> Privileged Gateway Intents, then restart the bot.');
        }
        return this.client;
      } catch (e) {
        lastError = e;
        const msg = e?.message || String(e);
        if (!/disallowed intents/i.test(msg)) throw e; // a token error must not be retried
        this.log.warn(`login rejected with the requested intents (attempt ${index + 1}/${ladder.length})`);
      }
    }
    throw lastError || new Error('login failed for an unknown reason');
  }

  /**
   * Reports the memory budget at boot, and warns when V8's heap ceiling is
   * larger than the memory the host will actually give us.
   *
   * This matters on a small VPS: V8 sizes its heap from total system memory, so
   * in a 256 MB container on a large host it happily plans for a multi-gigabyte
   * heap, never feels pressure, never collects aggressively, and gets OOM-killed
   * with no warning and no stack trace. Passing --max-old-space-size fixes it,
   * but only if somebody knows to.
   */
  reportMemoryBudget() {
    const v8 = require('node:v8');
    const os = require('node:os');
    const p = this.cacheProfile;

    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
    const availableMb = p.detectedLimitMb || p.totalMemoryMb;

    this.log.info(
      `memory profile: ${p.profile} (${p.meta.description}) — ` +
        `${p.detectedLimitMb ? `container limit ${p.detectedLimitMb} MB` : `host has ${p.totalMemoryMb} MB`}`,
    );

    if (heapLimitMb > availableMb * 0.9) {
      this.log.warn(
        `V8 will grow its heap to ${heapLimitMb} MB but only ~${availableMb} MB is available. ` +
          'It will not collect aggressively before the host kills the process.',
      );
      const suggested = Math.max(64, Math.floor(availableMb * 0.55));
      this.log.warn(`Start the bot with:  node --max-old-space-size=${suggested} index.js`);
      this.log.warn(`or set:  NODE_OPTIONS="--max-old-space-size=${suggested}"`);
    }

    if (p.meta.tradeoffs?.length) {
      for (const line of p.meta.tradeoffs) this.log.debug(`profile trade-off: ${line}`);
    }
    void os;
  }

  /**
   * Pushes the current command set to Discord.
   *
   * Lives here rather than in the ready handler because plugins can add and
   * remove commands at runtime, and both paths must produce exactly the same
   * payload.
   */
  async registerCommands() {
    if (!this.client?.user) return { ok: false, error: 'not logged in yet' };
    if (!this.config.registerCommands) return { ok: false, error: 'REGISTER_COMMANDS is off' };

    const { REST, Routes } = this.discord;
    const rest = new REST({ version: '10' }).setToken(this.config.token);
    const appId = this.client.user.id;
    const body = this.registry.toJSON({ features: this.config.features });

    // Where to register.
    //
    // Global registration is correct for a bot in many servers, but Discord can
    // take up to an hour to propagate it. For a self-hoster in one or two
    // servers that hour is spent wondering whether the setup is broken, and the
    // usual answer - "set GUILD_ID" - means hunting for a snowflake in a UI
    // where Developer Mode is off by default.
    //
    // So when GUILD_ID is not set and the bot is in a handful of servers, each
    // one is registered directly: same result, visible immediately, nothing to
    // configure. Past that threshold, per-guild calls stop being reasonable and
    // global is the right choice anyway.
    const AUTO_GUILD_LIMIT = 5;
    const joined = [...this.client.guilds.cache.keys()];
    let targets = null; // null means global

    if (this.config.guildId) {
      targets = [this.config.guildId];
    } else if (joined.length > 0 && joined.length <= AUTO_GUILD_LIMIT) {
      targets = joined;
    }

    if (body.length > 100) {
      const error = `${body.length} commands exceed Discord's limit of 100`;
      this.log.error(`${error}; registration skipped`);
      return { ok: false, error };
    }

    const started = Date.now();
    try {
      if (targets) {
        for (const id of targets) {
          await rest.put(Routes.applicationGuildCommands(appId, id), { body });
        }
        const took = Date.now() - started;

        // Guild and global registrations are independent sets, and Discord shows
        // both. A bot that once registered globally and now registers per guild
        // therefore ends up listing every command twice, as the old global set
        // finishes propagating - which looks like a bug in the bot and cannot be
        // fixed by restarting, because nothing ever removes the old set.
        //
        // Clearing it here is safe: the guild registrations above already cover
        // every server the bot is in.
        try {
          const globals = await rest.get(Routes.applicationCommands(appId));
          if (Array.isArray(globals) && globals.length) {
            await rest.put(Routes.applicationCommands(appId), { body: [] });
            this.log.info(
              `removed ${globals.length} stale global command(s) left by an earlier run; ` +
                'they would otherwise have appeared as duplicates',
            );
          }
        } catch (e) {
          this.log.debug(`could not check for stale global commands: ${e.message}`);
        }

        if (this.config.guildId) {
          this.log.info(`registered ${body.length} command(s) to guild ${this.config.guildId} in ${took}ms (instant)`);
        } else {
          const names = targets
            .map((id) => this.client.guilds.cache.get(id)?.name || id)
            .join(', ');
          this.log.info(
            `registered ${body.length} command(s) to ${targets.length} server(s) in ${took}ms — available now`,
          );
          this.log.info(`  ${names}`);
          this.log.info('  (no GUILD_ID set, so each server was registered directly rather than globally,');
          this.log.info('   which would have taken up to an hour to appear)');
        }
      } else {
        await rest.put(Routes.applicationCommands(appId), { body });
        this.log.info(`registered ${body.length} command(s) globally in ${Date.now() - started}ms`);
      }
      return { ok: true, count: body.length, scope: targets ? 'guild' : 'global' };
    } catch (e) {
      this.log.error(`command registration failed: ${e.message}`);
      if (/missing access|50001/i.test(e.message)) {
        this.log.error('The bot was invited without the applications.commands scope.');
        this.log.error('Re-invite it with both bot and applications.commands selected.');
      }
      if (/unknown guild|50035/i.test(e.message) && this.config.guildId) {
        this.log.error(
          `GUILD_ID=${this.config.guildId} is not a server this bot is in. Clear it and the bot will ` +
            'register to whichever servers it is actually in.',
        );
      }
      return { ok: false, error: e.message };
    }
  }

  // ---------- helpers used across the codebase ----------

  /** True when the user is configured as a bot owner. */
  isOwner(userId) {
    return this.config.owners.includes(String(userId));
  }

  /** Merged settings for a guild, or the defaults when outside a guild. */
  settings(guildId) {
    return this.db.settings(guildId || '0');
  }

  /** Bound translator for a guild, falling back to the process default. */
  t(guildId) {
    const locale = guildId ? this.settings(guildId).locale : null;
    return i18n.translator(locale || this.config.defaultLocale);
  }

  /** Whether a feature is on both globally and for this guild. */
  featureEnabled(guildId, feature) {
    if (this.config.features[feature] === false) return false;
    const s = this.settings(guildId);
    if (s[feature] && typeof s[feature].enabled === 'boolean') return s[feature].enabled;
    return true;
  }

  /**
   * Resolves a channel id from settings, verifying the bot can post there.
   * Returns null instead of throwing so callers can degrade quietly.
   */
  async resolveChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return null;
    const perms = channel.permissionsFor(guild.members.me);
    const { PermissionFlagsBits } = this.discord;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) return null;
    return channel;
  }

  /** Sends to a configured channel, swallowing the common permission failures. */
  async sendTo(guild, channelId, payload) {
    const channel = await this.resolveChannel(guild, channelId);
    if (!channel) return null;
    return channel.send(payload).catch((e) => {
      this.log.debug(`could not post in ${channelId}: ${e.message}`);
      return null;
    });
  }

  /** Uptime in milliseconds since the process started. */
  get uptime() {
    return Date.now() - this.startedAt;
  }

  /** Aggregate diagnostics used by /stats and /botinfo. */
  snapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeMs: this.uptime,
      readyAt: this.readyAt,
      guilds: this.client?.guilds?.cache?.size || 0,
      users: this.client?.guilds?.cache?.reduce((sum, g) => sum + (g.memberCount || 0), 0) || 0,
      channels: this.client?.channels?.cache?.size || 0,
      ping: Math.round(this.client?.ws?.ping ?? -1),
      memoryMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      node: process.version,
      djs: this.discord.version,
      counters: { ...this.counters },
      registry: this.registry.stats(),
      scheduler: this.scheduler.stats(),
      cooldowns: this.cooldowns.stats(),
      paginator: this.paginator.stats(),
      storage: this.db.stats(),
      intents: { ...this.intents },
      features: Object.keys(this.features),
      plugins: this.plugins ? this.plugins.stats() : { total: 0, loaded: 0, failed: 0, disabled: 0, watching: false },
      logLines: logBuffer.items.length,
      logFile: fileStats(),
      cacheProfile: this.cacheProfile?.profile || 'unknown',
      caches: cacheProfiles.snapshot(this.client),
      memoryLimitMb: this.cacheProfile?.detectedLimitMb || null,
    };
  }

  // ---------- shutdown ----------

  async shutdown() {
    this.scheduler.stop();
    this.cooldowns.stop();
    clearInterval(this.saveTimer);
    clearInterval(this.backupTimer);

    // Plugins first: one of them may be holding a port that a supervisor is
    // about to hand to the replacement process.
    if (this.plugins) {
      try {
        await this.plugins.disposeAll();
      } catch (e) {
        this.log.warn(`plugin teardown had problems: ${e.message}`);
      }
    }

    // Give features a chance to persist anything they hold in memory.
    for (const [name, feature] of Object.entries(this.features)) {
      if (typeof feature.shutdown === 'function') {
        try {
          await feature.shutdown();
        } catch (e) {
          this.log.warn(`feature ${name} failed to shut down cleanly: ${e.message}`);
        }
      }
    }

    this.db.close();
    try {
      await this.client?.destroy();
    } catch {
      /* the process is going away regardless */
    }
  }
}

module.exports = Bot;
