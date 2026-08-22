'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const { JsonStore } = require('./store');

/**
 * Plugin host.
 *
 * Drop a .js file into plugins/ and it loads on boot. Two styles are supported
 * and they can be mixed freely:
 *
 *   1. A standalone script. It simply runs when loaded, exactly as if you had
 *      run `node plugins/httpserver.js`. Nothing to export, nothing to learn.
 *
 *   2. A module exporting `init(plugin)` (and optionally `unload`), which gets a
 *      context object with the bot, a scoped logger, persistent storage, and
 *      hooks to register commands, buttons and scheduled tasks.
 *
 * ── How a plugin can be unloaded cleanly ───────────────────────────────────
 *
 * `delete require.cache[...]` does not undo anything a module already did. A
 * plugin that opened a port keeps that port; one that called setInterval keeps
 * ticking. So plugins are not loaded with plain `require`. Each file is
 * compiled with vm.compileFunction and given extra parameters that shadow the
 * globals in that module's scope:
 *
 *     (exports, require, module, __filename, __dirname,
 *      plugin, setTimeout, setInterval, setImmediate, console)
 *
 * Which means, without the plugin doing anything special:
 *
 *   - every timer it creates is tracked and cleared on unload
 *   - `require('http').createServer()` returns a server that is tracked and
 *     closed on unload (same for https and net)
 *   - `console.log` is routed into the bot's logger, tagged with the plugin
 *     name, so panel output stays readable
 *   - the free variable `plugin` is available for anything else
 *
 * Anything the host cannot see - a database driver's connection pool, a
 * third-party client - should be handed to `plugin.track(resource)`.
 *
 * ── Trust ──────────────────────────────────────────────────────────────────
 *
 * A plugin runs in this process with this process's privileges. It can read the
 * token, the data directory and the filesystem. `vm` is not a security
 * boundary and this module does not pretend otherwise: installing a plugin is
 * exactly as consequential as editing the bot's own source. Only install code
 * you have read or trust.
 */

/**
 * Rejects an address the installer must never fetch from.
 *
 * The danger is not the hostname but what it resolves to. On a cloud host
 * 169.254.169.254 serves instance credentials to anything that asks, and
 * 127.0.0.1 reaches whatever else this container is running - neither needs a
 * suspicious-looking URL to reach, only a DNS record pointing there. So the
 * check is on the resolved address, and it runs again for every redirect hop.
 */
async function assertPublicAddress(url) {
  const dns = require('node:dns').promises;
  const net = require('node:net');

  let addresses;
  const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (literal) {
    addresses = [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: literal }];
  } else {
    try {
      addresses = await dns.lookup(url.hostname, { all: true });
    } catch {
      throw new Error(`${url.hostname} does not resolve`);
    }
  }

  for (const { address } of addresses) {
    if (isInternalAddress(address)) {
      throw new Error(
        `${url.hostname} resolves to ${address}, which is inside this network. ` +
          'Plugins are only installed from public addresses.',
      );
    }
  }
}

/** True for loopback, link-local, private and other non-public ranges. */
function isInternalAddress(address) {
  const net = require('node:net');

  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this host, private, loopback
    if (a === 169 && b === 254) return true; // link-local, including cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(lower)) return true; // unique local
    // An IPv4 address wearing an IPv6 hat still has to pass the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isInternalAddress(mapped[1]);
    return false;
  }

  return true; // unparseable, so not demonstrably public
}

/** Extensions treated as native addons. */
const NATIVE_EXTENSIONS = new Set(['.node', '.so', '.dll', '.dylib']);

/**
 * Methods tried, in order, when closing a tracked resource.
 *
 * `closeAllConnections` is deliberately NOT in this list even though every
 * http.Server has one. It drops live sockets but does not stop the listener, so
 * treating it as a shutdown method leaves the port bound - which looks like a
 * successful unload right up until the reload fails with EADDRINUSE. It is
 * instead called as a *preparatory* step before close(), because close() alone
 * never finishes while a keep-alive connection is open.
 */
const CLOSERS = ['close', 'destroy', 'stop', 'kill', 'disconnect', 'end', 'terminate', 'unload'];

/**
 * Of those, the ones whose first argument is a completion callback.
 *
 * The rest take something else entirely - `kill(signal)` is the one that bites,
 * because passing it a function throws "Unknown signal" and leaves the child
 * process running. Anything not listed here is called with no arguments and
 * waited on through its 'exit' / 'close' / 'end' event instead.
 */
const CALLBACK_CLOSERS = new Set(['close', 'end']);

/**
 * Core modules whose factory functions hand back something that has to be
 * reclaimed, and which are therefore wrapped in the require a plugin sees.
 *
 * The point is that a plugin written as a plain script - no exports, no
 * cleanup, nothing learned - still unloads cleanly. A listener that keeps a
 * port and a child process that keeps running are the same kind of leak, and
 * neither should need the plugin author to have thought about it.
 *
 * The synchronous child_process calls are absent on purpose: execSync and
 * friends have already finished by the time they return, so there is nothing
 * left to track.
 */
const TRACKED_FACTORIES = {
  http: new Set(['createServer']),
  https: new Set(['createServer']),
  http2: new Set(['createServer', 'createSecureServer']),
  net: new Set(['createServer']),
  tls: new Set(['createServer']),
  child_process: new Set(['spawn', 'fork', 'exec', 'execFile']),
};

/**
 * The object a plugin receives, both as the `plugin` free variable and as the
 * argument to `init()`. Everything registered through it is remembered so it
 * can be undone.
 */
class PluginContext {
  constructor(host, { name, file, config, log }) {
    this.host = host;
    this.bot = host.bot;
    this.name = name;
    this.file = file;
    this.dir = path.dirname(file);
    this.log = log;
    this.config = config;
    this.loadedAt = Date.now();

    /** @type {{ timers: Set, resources: Array, listeners: Array, cleanups: Array,
     *           commands: string[], components: string[], tasks: string[] }} */
    this.owned = {
      timers: new Set(),
      resources: [],
      listeners: [],
      cleanups: [],
      commands: [],
      components: [],
      tasks: [],
    };

    this._store = null;
  }

  /**
   * Lazily-created persistent storage, at data/plugin-store/<name>.json.
   *
   * Deliberately not inside the plugins directory. That directory now holds the
   * plugin *code*, and mixing a plugin's data into it means one unwritable path
   * breaks both, a listing of plugins is half data files, and deleting a plugin
   * is ambiguous about whether its data went too.
   */
  get store() {
    if (!this._store) {
      const dir = path.join(this.bot.config.dataDir, 'plugin-store');
      fs.mkdirSync(dir, { recursive: true });
      this._store = new JsonStore(path.join(dir, `${this.name}.json`), {
        defaults: {},
        saveIntervalMs: this.bot.config.saveIntervalMs,
        backupCount: 1,
        log: this.log,
      });
      this.track(this._store, (s) => s.close());
    }
    return this._store;
  }

  // ---------- resource tracking ----------

  /**
   * Remembers a resource so it is closed on unload.
   * @param {*} resource anything with a close/destroy/stop method
   * @param {(r: *) => void} [closer] custom shutdown, when the default guess is wrong
   * @returns the resource, so this can wrap an expression inline
   */
  track(resource, closer = null) {
    if (resource) this.owned.resources.push({ resource, closer });
    return resource;
  }

  /**
   * Loads an ESM module from a plugin.
   *
   * A plugin is CommonJS, so `require()` cannot load an ESM-only package - and
   * a growing share of npm is ESM-only. Native `await import()` works on
   * Node 20.10+ but not on 18, so this is the portable form:
   *
   *     const { default: chalk } = await plugin.import('chalk');
   *
   * Relative specifiers resolve against the plugin's own directory rather than
   * against the bot's source tree.
   */
  import(specifier) {
    const target =
      specifier.startsWith('.') || path.isAbsolute(specifier)
        ? pathToFileURL(path.resolve(this.dir, specifier)).href
        : specifier;
    return import(target);
  }

  /** Registers a function to run on unload. Run in reverse order of addition. */
  addCleanup(fn) {
    if (typeof fn === 'function') this.owned.cleanups.push(fn);
    return this;
  }

  /** Adds an event listener that is removed on unload. */
  on(emitter, event, handler) {
    emitter.on(event, handler);
    this.owned.listeners.push({ emitter, event, handler });
    return this;
  }

  /** Same, but fires at most once. */
  once(emitter, event, handler) {
    emitter.once(event, handler);
    this.owned.listeners.push({ emitter, event, handler });
    return this;
  }

  /** Listens to a Discord gateway event. Shorthand for on(client, ...). */
  onDiscord(event, handler) {
    return this.on(this.bot.client, event, handler);
  }

  /**
   * Runs `fn` once the gateway is ready, or immediately if it already is.
   * Plugins load before login, so `bot.client.user` is null at init time.
   */
  onReady(fn) {
    if (this.bot.readyAt) {
      Promise.resolve(fn(this.bot.client)).catch((e) => this.log.error('onReady handler failed:', e));
      return this;
    }
    return this.once(this.bot.client, 'clientReady', (client) =>
      Promise.resolve(fn(client)).catch((e) => this.log.error('onReady handler failed:', e)),
    );
  }

  // ---------- tracked timers ----------
  // These shadow the globals inside the plugin's module scope, so a plugin that
  // just calls setInterval() still gets cleaned up.

  setTimeout(fn, ms, ...args) {
    const id = setTimeout(
      (...a) => {
        this.owned.timers.delete(id);
        try {
          fn(...a);
        } catch (e) {
          this.log.error('timer callback threw:', e);
        }
      },
      ms,
      ...args,
    );
    this.owned.timers.add(id);
    return id;
  }

  setInterval(fn, ms, ...args) {
    const id = setInterval(
      (...a) => {
        try {
          fn(...a);
        } catch (e) {
          this.log.error('interval callback threw:', e);
        }
      },
      ms,
      ...args,
    );
    this.owned.timers.add(id);
    return id;
  }

  setImmediate(fn, ...args) {
    const id = setImmediate((...a) => {
      this.owned.timers.delete(id);
      try {
        fn(...a);
      } catch (e) {
        this.log.error('immediate callback threw:', e);
      }
    }, ...args);
    this.owned.timers.add(id);
    return id;
  }

  clearTimer(id) {
    clearTimeout(id);
    clearInterval(id);
    this.owned.timers.delete(id);
  }

  // ---------- bot integration ----------

  /**
   * Registers a slash command. The command shape is the same as the files in
   * src/commands. Discord is told about it after the plugin finishes loading.
   */
  registerCommand(command) {
    const result = this.bot.registry.add(command, { source: `plugin:${this.name}` });
    if (!result.ok) {
      this.log.error(`command rejected: ${result.error}`);
      return false;
    }
    this.owned.commands.push(command.data.name);
    this.host.commandsDirty = true;
    this.log.debug(`registered /${command.data.name}`);
    return true;
  }

  /** Registers a button/select/modal namespace, e.g. "myplugin" for "myplugin:go". */
  registerComponent(namespace, handler) {
    if (this.bot.components.has(namespace)) {
      this.log.error(`component namespace "${namespace}" is already taken`);
      return false;
    }
    this.bot.components.register(namespace, handler);
    this.owned.components.push(namespace);
    return true;
  }

  /** Registers a persistent scheduled-task handler. */
  registerTask(type, handler) {
    this.bot.scheduler.register(type, handler);
    this.bot.scheduler.revive(type);
    this.owned.tasks.push(type);
    return true;
  }

  /** Schedules a task of a type this plugin registered. */
  schedule(type, runAt, data = {}, opts = {}) {
    return this.bot.scheduler.schedule(type, runAt, data, opts);
  }

  /** Summary used by /plugin info. */
  describe() {
    return {
      timers: this.owned.timers.size,
      resources: this.owned.resources.length,
      listeners: this.owned.listeners.length,
      cleanups: this.owned.cleanups.length,
      commands: [...this.owned.commands],
      components: [...this.owned.components],
      tasks: [...this.owned.tasks],
    };
  }

  /** Undoes everything this plugin did. Never throws. */
  async dispose() {
    const problems = [];

    // Custom cleanups first, in reverse: a plugin's own shutdown may need the
    // resources that are about to be closed.
    for (const fn of [...this.owned.cleanups].reverse()) {
      try {
        await fn();
      } catch (e) {
        problems.push(`cleanup: ${e.message}`);
      }
    }

    for (const { resource, closer } of this.owned.resources.reverse()) {
      try {
        if (closer) {
          await closer(resource);
          continue;
        }
        const method = CLOSERS.find((m) => typeof resource[m] === 'function');
        if (!method) {
          problems.push(`no way to close a ${resource?.constructor?.name || typeof resource}`);
          continue;
        }
        // A server with keep-alive connections never finishes close() on its
        // own, so drop the sockets first when the runtime offers a way to.
        for (const drain of ['closeAllConnections', 'closeIdleConnections']) {
          if (typeof resource[drain] === 'function') {
            try {
              resource[drain]();
            } catch {
              /* draining is best effort; close() below is what matters */
            }
          }
        }

        // listen() is asynchronous. A plugin that binds a port and then throws
        // on the next line is disposed while the socket is still mid-bind:
        // close() reports ERR_SERVER_NOT_RUNNING, the bind then completes, and
        // the port stays held for the life of the process. Closing again once
        // it is actually listening is the only way to catch that race - and it
        // only reproduces on Linux, where the bind lands after the close.
        if ('listening' in resource && resource.listening === false && typeof resource.once === 'function') {
          resource.once('listening', () => {
            try {
              resource.close();
            } catch {
              /* already gone, which is the outcome we wanted */
            }
          });
        }
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          try {
            // A completion callback is only correct for the methods that take
            // one. ChildProcess.kill() takes a *signal*, so handing it a
            // function makes it throw "Unknown signal" and the child survives
            // the unload - a leaked OS process for every reload, which on a
            // small host is the difference between working and being killed.
            // Where no callback is accepted, wait for the object to say it is
            // finished instead.
            const returned = CALLBACK_CLOSERS.has(method) ? resource[method](done) : resource[method]();
            if (returned && typeof returned.then === 'function') returned.then(done, done);

            if (!CALLBACK_CLOSERS.has(method) && typeof resource.once === 'function') {
              for (const event of ['exit', 'close', 'end']) resource.once(event, done);
            } else if (!CALLBACK_CLOSERS.has(method)) {
              done();
            }
          } catch (e) {
            problems.push(`${method}(): ${e.message}`);
            done();
          }
          // Never let one stuck resource block the whole unload.
          setTimeout(done, 3000).unref?.();
        });
      } catch (e) {
        problems.push(`close: ${e.message}`);
      }
    }

    for (const { emitter, event, handler } of this.owned.listeners) {
      try {
        emitter.removeListener(event, handler);
      } catch (e) {
        problems.push(`removeListener: ${e.message}`);
      }
    }

    for (const id of this.owned.timers) {
      clearTimeout(id);
      clearInterval(id);
    }

    for (const name of this.owned.commands) {
      this.bot.registry.remove(name);
      this.host.commandsDirty = true;
    }
    for (const namespace of this.owned.components) this.bot.components.unregister(namespace);
    for (const type of this.owned.tasks) this.bot.scheduler.unregister(type);

    this.owned = {
      timers: new Set(),
      resources: [],
      listeners: [],
      cleanups: [],
      commands: [],
      components: [],
      tasks: [],
    };

    return problems;
  }
}

/** One loaded (or failed) plugin. */
class Plugin {
  constructor({ name, file, kind }) {
    this.name = name;
    this.file = file;
    this.kind = kind; // 'script' | 'module' | 'native'
    this.state = 'pending'; // pending | loaded | failed | disabled
    this.error = null;
    this.exports = null;
    this.context = null;
    this.loadedAt = 0;
    this.meta = {};
  }

  get version() {
    return this.meta.version || null;
  }

  get description() {
    return this.meta.description || null;
  }
}

class PluginHost {
  /**
   * @param {import('../bot')} bot
   * @param {{ dir: string, log: object }} opts
   */
  constructor(bot, { dir, log }) {
    this.bot = bot;
    this.dir = dir;
    this.log = log;
    /** @type {Map<string, Plugin>} */
    this.plugins = new Map();
    this.commandsDirty = false;
    this.watcher = null;
    this.watchTimers = new Map();
    this.manifest = { ignored: [], config: {}, urls: [], packages: [] };
  }

  // ---------- discovery ----------

  /**
   * Reads plugins/plugins.json, which is optional, then lets the environment
   * override it.
   *
   * The file is the natural place for this, and unusable on the hosts that need
   * it most: a container that mounts the project read-only gives you no way to
   * edit it, and a copy written to a scratch directory is gone at the next
   * restart. Two environment variables cover both directions.
   */
  readManifest() {
    const file = path.join(this.dir, 'plugins.json');
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.manifest = {
          // Same word as the environment variable, so it is obvious that one
          // overrides the other rather than combining with it.
          ignored: Array.isArray(parsed.ignored) ? parsed.ignored : [],
          config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
          urls: Array.isArray(parsed.urls) ? parsed.urls : [],
          packages: Array.isArray(parsed.packages) ? parsed.packages : [],
        };
      }
    } catch (e) {
      this.log.warn(`plugins.json is unreadable, ignoring it: ${e.message}`);
    }

    /**
     * Reads a list from an environment variable.
     *
     * Comma separated is the common form, and there is no standard for lists in
     * the environment - but comma separated cannot express "empty", and some
     * platforms will not store an empty value at all. So a JSON array is
     * accepted too, which makes `[]` an explicit way to say "none" on a
     * platform that would otherwise drop the variable.
     */
    const parseList = (value) => {
      const raw = String(value ?? '').trim();
      if (!raw || raw === '[]') return [];
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.map((n) => String(n).trim()).filter(Boolean);
        } catch {
          // Fall through to comma separation rather than rejecting the whole
          // value: a stray bracket should not silently disable the setting.
        }
      }
      return raw
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    };
    const names = parseList;

    // PLUGINS_IGNORED *replaces* the file's list rather than adding to it.
    //
    // Adding was the mistake that made a second variable necessary last time:
    // a list you can only grow cannot re-enable anything, so a host where
    // plugins.json is read-only had no way to undo what the file said. Replacing
    // covers both directions with one variable, and an empty value is a
    // meaningful answer - it means nothing is ignored.
    if (Object.prototype.hasOwnProperty.call(process.env, 'PLUGINS_IGNORED')) {
      this.manifest.ignored = parseList(process.env.PLUGINS_IGNORED);
      this.log.debug(
        this.manifest.ignored.length
          ? `PLUGINS_IGNORED: ${this.manifest.ignored.join(', ')}`
          : 'PLUGINS_IGNORED is empty, so nothing is ignored',
      );
    }

    const packages = parseList(process.env.PLUGINS_PACKAGES);
    if (packages.length) this.manifest.packages = [...new Set([...this.manifest.packages, ...packages])];

    const urls = names(process.env.PLUGINS_URLS);
    if (urls.length) this.manifest.urls = [...new Set([...this.manifest.urls, ...urls])];
  }

  /**
   * Works out the entry point of a directory plugin.
   *
   * `package.json` is honoured the way Node itself does: the `main` field names
   * the entry file, defaulting to index.js. That is what makes a plugin folder
   * cloned from somewhere else work without rearranging it.
   *
   * What is deliberately NOT honoured is `scripts.start`. A plugin is loaded
   * into this process, not spawned - there is no separate process for a start
   * command to launch, and running one would mean dropping a folder into
   * plugins/ silently executes a shell command.
   *
   * @returns {{ file: string, manifest: object|null }|null}
   */
  static resolveDirectory(dir) {
    let manifest = null;
    const manifestPath = path.join(dir, 'package.json');

    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        // A malformed package.json should not make the directory invisible;
        // fall back to index.js and record why.
        manifest = { _error: e.message };
      }
    }

    const candidates = [];
    if (manifest && typeof manifest.main === 'string' && manifest.main.trim()) {
      const target = path.resolve(dir, manifest.main);
      const root = path.resolve(dir);
      // `main` must stay inside the plugin folder: "../../src/bot.js" would
      // otherwise let a dropped-in folder point the loader anywhere on disk.
      if (target === root || target.startsWith(root + path.sep)) {
        candidates.push(target);
        // npm also allows "main": "lib", meaning lib/index.js
        candidates.push(path.join(target, 'index.js'));
      }
    }
    candidates.push(path.join(dir, 'index.js'), path.join(dir, 'index.cjs'));

    const file = candidates.find((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
    return file ? { file, manifest } : null;
  }

  /**
   * Declared dependencies that are not installed next to the plugin.
   * @returns {{ missing: string[], dir: string }|null}
   */
  static checkDependencies(file, manifest) {
    if (!manifest?.dependencies) return null;
    const names = Object.keys(manifest.dependencies);
    if (!names.length) return null;

    const dir = path.dirname(file);
    const modules = path.join(dir, 'node_modules');
    const missing = names.filter((name) => !fs.existsSync(path.join(modules, ...name.split('/'))));
    return missing.length ? { missing, dir } : null;
  }

  /**
   * Files eligible to be plugins. Skipped: dotfiles, underscore-prefixed
   * helpers, anything under node_modules or a directory named _disabled, the
   * manifest itself, and .example files.
   */
  discover() {
    const out = [];
    const walk = (current, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        if (entry.name === 'node_modules') continue;

        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          // A directory plugin is loaded through one entry point, so its helper
          // files and node_modules are not each loaded as separate plugins.
          const resolved = PluginHost.resolveDirectory(full);
          if (resolved) {
            out.push({ name: entry.name, file: resolved.file, kind: 'module', manifest: resolved.manifest });
            continue;
          }
          if (depth < 2) walk(full, depth + 1);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (entry.name === 'plugins.json') continue;
        if (entry.name.includes('.example.')) continue;

        if (ext === '.js' || ext === '.cjs') {
          out.push({ name: path.basename(entry.name, ext), file: full, kind: 'script' });
        } else if (NATIVE_EXTENSIONS.has(ext)) {
          out.push({ name: path.basename(entry.name, ext), file: full, kind: 'native' });
        }
      }
    };

    walk(this.dir, 0);
    return out;
  }

  // ---------- loading ----------

  /** Loads every discovered plugin. Returns a count summary. */
  async loadAll() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.log.debug(`created ${this.dir}`);
    }
    this.readManifest();

    const found = this.discover();
    if (!found.length) {
      this.log.debug('no plugins found');
      return { loaded: 0, failed: 0, disabled: 0 };
    }

    let loaded = 0;
    let failed = 0;
    let disabled = 0;

    for (const entry of found) {
      if (this.manifest.ignored.includes(entry.name)) {
        const plugin = new Plugin(entry);
        plugin.state = 'disabled';
        this.plugins.set(entry.name, plugin);
        disabled++;
        continue;
      }
      const ok = await this.load(entry);
      ok ? loaded++ : failed++;
    }

    this.log.info(
      `plugins: ${loaded} loaded` +
        (failed ? `, ${failed} failed` : '') +
        (disabled ? `, ${disabled} disabled` : ''),
    );
    return { loaded, failed, disabled };
  }

  /**
   * Loads one plugin.
   * @param {{ name: string, file: string, kind: string }} entry
   * @returns {Promise<boolean>} whether it loaded
   */
  async load(entry) {
    const existing = this.plugins.get(entry.name);
    if (existing?.state === 'loaded') {
      this.log.warn(`plugin "${entry.name}" is already loaded`);
      return false;
    }

    const plugin = new Plugin(entry);
    this.plugins.set(entry.name, plugin);

    const log = this.bot.log.child(`plugin:${entry.name}`);
    const context = new PluginContext(this, {
      name: entry.name,
      file: entry.file,
      config: this.manifest.config[entry.name] || {},
      log,
    });
    plugin.context = context;

    try {
      // An in-memory plugin has source but no file on disk.
      if (entry.source !== undefined) {
        plugin.exports = this.compileSource(entry.source, entry.file, context);
        plugin.kind = 'memory';
        plugin.ephemeral = true;
        plugin.origin = entry.origin || null;

        const exported = plugin.exports || {};
        plugin.meta = { version: exported.version, description: exported.description, author: exported.author };

        const initFn = exported.init || exported.setup;
        if (typeof initFn === 'function') await initFn(context);

        plugin.state = 'loaded';
        plugin.loadedAt = Date.now();
        log.debug(`loaded from memory${entry.origin ? ` (${entry.origin})` : ''}`);
        return true;
      }

      // A directory plugin may declare dependencies. They are never installed
      // silently at boot: npm itself needs well over 100 MB, which on the kind
      // of small host this bot targets is enough to push the container into the
      // OOM killer while it is starting. Opt in with PLUGIN_AUTO_INSTALL=true,
      // or install them yourself - the message says exactly how.
      const needs = PluginHost.checkDependencies(entry.file, entry.manifest);
      if (needs) {
        if (this.bot.config.pluginAutoInstall) {
          log.info(`installing ${needs.missing.length} declared dependency(ies): ${needs.missing.join(', ')}`);
          const result = await this.installDependencies(needs.dir);
          if (!result.ok) {
            throw new Error(
              `npm install failed in ${path.basename(needs.dir)} (exit ${result.code}). ` +
                `Last output: ${result.output.slice(-400)}`,
            );
          }
          log.debug('dependencies installed');
        } else {
          log.warn(
            `declares ${needs.missing.length} dependency(ies) that are not installed: ${needs.missing.join(', ')}`,
          );
          log.warn(`  install them with:  cd ${needs.dir} && npm install`);
          log.warn('  or set PLUGIN_AUTO_INSTALL=true to have this done on load');
          // Loading continues: the plugin may only need them on a code path
          // that is never reached, and failing outright would be worse than a
          // clear require() error at the moment it actually matters.
        }
      }

      plugin.exports = entry.kind === 'native' ? this.loadNative(entry.file) : this.compileAndRun(entry.file, context);

      // Metadata comes from the module's exports first, then package.json.
      // A bare script has neither, which is fine.
      const exported = plugin.exports || {};
      const manifest = entry.manifest || {};
      if (manifest._error) log.warn(`package.json is malformed and was ignored: ${manifest._error}`);

      plugin.meta = {
        version: exported.version ?? manifest.version,
        description: exported.description ?? manifest.description,
        author: exported.author ?? (typeof manifest.author === 'string' ? manifest.author : manifest.author?.name),
        entry: path.basename(entry.file),
      };

      const init = exported.init || exported.setup;
      if (typeof init === 'function') {
        plugin.kind = 'module';
        await init(context);
      } else if (entry.kind !== 'native') {
        // No init export: the file already did its work as it ran. Perfectly
        // valid, and the common case for "drop in a script that starts a server".
        plugin.kind = 'script';
      }

      plugin.state = 'loaded';
      plugin.loadedAt = Date.now();

      const owned = context.describe();
      const summary = [
        owned.commands.length ? `${owned.commands.length} command(s)` : null,
        owned.timers ? `${owned.timers} timer(s)` : null,
        owned.resources ? `${owned.resources} resource(s)` : null,
        owned.listeners ? `${owned.listeners} listener(s)` : null,
      ]
        .filter(Boolean)
        .join(', ');

      log.info(`loaded${summary ? ` — ${summary}` : ''}`);
      return true;
    } catch (e) {
      plugin.state = 'failed';
      plugin.error = e;
      log.error('failed to load:', e);

      // A plugin that threw halfway may still have opened things.
      await context.dispose().catch(() => {});
      return false;
    }
  }

  /**
   * Compiles a plugin file with extra parameters in scope and runs it.
   * See the module header for why this is not plain require().
   */
  compileAndRun(file, context) {
    return this.compileSource(fs.readFileSync(file, 'utf8'), file, context);
  }

  /**
   * Compiles and runs plugin source that may never have touched the disk.
   *
   * `file` is a path used for stack traces and for resolving require(); for an
   * in-memory plugin it is a path inside the plugins directory that does not
   * exist. Node only needs the *directory* to resolve from, so relative
   * requires still work against the plugins folder and bare specifiers still
   * find the bot's node_modules.
   */
  compileSource(source, file, context) {
    const dirname = path.dirname(file);

    const module_ = { exports: {}, filename: file, id: file, loaded: false, paths: [] };
    const requireFn = this.makeRequire(file, context);

    // console is redirected so a plugin's stray console.log lands in the bot's
    // log with a plugin tag, rather than as an untraceable bare line.
    const pluginConsole = {
      log: (...a) => context.log.info(...a),
      info: (...a) => context.log.info(...a),
      warn: (...a) => context.log.warn(...a),
      error: (...a) => context.log.error(...a),
      debug: (...a) => context.log.debug(...a),
      trace: (...a) => context.log.trace(...a),
      dir: (...a) => context.log.debug(...a),
      table: (...a) => context.log.info(...a),
    };

    const params = [
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      'plugin',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'console',
    ];

    const options = { filename: file };

    // Native `await import(...)` inside a compiled function needs an explicit
    // loader, or it throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. Node 20.10+
    // can borrow the main context's loader, which needs no command-line flag.
    //
    // It is only wired up when the source actually contains a dynamic import,
    // because requesting it emits an ExperimentalWarning - and a plugin that
    // never imports anything should not make the log noisier.
    //
    // On older Node, and as the always-portable option, plugins use
    // `plugin.import()` instead; see PluginContext.import.
    if (/\bimport\s*\(/.test(source) && vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER !== undefined) {
      options.importModuleDynamically = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
    }

    let fn;
    try {
      fn = vm.compileFunction(source, params, options);
    } catch (e) {
      // A syntax error here is the plugin author's, and the message from V8 is
      // the useful part - re-throw it with the file attached. Two cases get an
      // extra sentence because V8's wording does not suggest the fix, and both
      // are the first thing someone hits when pasting in modern example code.
      const name = path.basename(file);
      if (/import statement outside a module|Unexpected token 'export'/.test(e.message)) {
        throw new Error(
          `${name} uses ESM syntax, but plugins are CommonJS. ` +
            `Use "const x = require('x')" instead of "import x from 'x'", and ` +
            `"module.exports = {...}" instead of "export". ` +
            `To load an ESM-only package, use "await plugin.import('pkg')" inside an async init(). ` +
            `Original error: ${e.message}`,
        );
      }
      if (/await is only valid in async/.test(e.message)) {
        throw new Error(
          `${name} uses top-level await, which a CommonJS plugin cannot do. ` +
            `Move the awaiting code into "module.exports = { async init(plugin) { ... } }". ` +
            `Original error: ${e.message}`,
        );
      }
      throw new Error(`syntax error in ${name}: ${e.message}`);
    }

    fn(
      module_.exports,
      requireFn,
      module_,
      file,
      dirname,
      context,
      (f, ms, ...a) => context.setTimeout(f, ms, ...a),
      (f, ms, ...a) => context.setInterval(f, ms, ...a),
      (f, ...a) => context.setImmediate(f, ...a),
      (id) => context.clearTimer(id),
      (id) => context.clearTimer(id),
      pluginConsole,
    );

    module_.loaded = true;
    return module_.exports;
  }

  /**
   * Builds the `require` a plugin sees. It resolves relative to the plugin file
   * (so a plugin can require its own helpers and the bot's dependencies), and
   * wraps the server-creating core modules so ports are released on unload.
   */
  makeRequire(file, context) {
    const real = Module.createRequire(file);
    // Second resolver rooted at the bot itself. Plugins live under the data
    // directory, outside the project tree, and Node resolves node_modules by
    // walking up from the importing file - so without this fallback a plugin
    // could not require('discord.js'). Relative and absolute ids are never
    // redirected: those are the plugin's own files and a silent substitution
    // would be worse than the error.
    const fallback = Module.createRequire(path.join(this.bot.config.rootDir, 'index.js'));

    // Third resolver, for packages /plugin npm had to install outside the
    // project because the project is read-only. Identical to fallback when the
    // project is writable, which is the ordinary case.
    const installed = Module.createRequire(path.join(this.modulesDir.dir, 'index.js'));

    const resolveEither = (id) => {
      try {
        return real(id);
      } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
        if (id.startsWith('.') || id.startsWith('/') || path.isAbsolute(id)) throw e;
        try {
          return fallback(id);
        } catch (e2) {
          if (e2.code !== 'MODULE_NOT_FOUND') throw e2;
          try {
            return installed(id);
          } catch (e3) {
            if (e3.code !== 'MODULE_NOT_FOUND') throw e3;
          }
          // Node's own message ends with a require stack pointing at the bot's
          // index.js - an artefact of the fallback resolver above, and actively
          // misleading to someone whose plugin is missing a package. Replace it
          // with the two places that would actually fix it.
          const err = new Error(
            `Cannot find module '${id}'. A plugin's dependencies are not installed automatically.\n` +
              `  Install it from Discord:      /plugin npm package:${id}\n` +
              `  Or from a shell:              npm install ${id}   (in ${this.modulesDir.dir})\n` +
              `  Or keep it with this plugin:  make ${path.basename(file, path.extname(file))} a directory ` +
              `with its own package.json and node_modules, and an index.js entry point.`,
          );
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
      }
    };

    const wrapped = (id) => {
      const loaded = resolveEither(id);
      const bare = String(id).replace(/^node:/, '');
      const tracked = TRACKED_FACTORIES[bare];
      if (!tracked) return loaded;

      // A Proxy keeps every other export intact, including lazy getters.
      return new Proxy(loaded, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (!tracked.has(prop) || typeof value !== 'function') {
            return typeof value === 'function' ? value.bind(target) : value;
          }

          return (...args) => {
            const created = value.apply(target, args);

            // `detached: true` is a plugin saying, in the only way the runtime
            // provides, that this process is meant to outlive its parent. That
            // is the one case where killing it on unload would be wrong, so it
            // is the one case left alone. Everything else is reclaimed: a
            // spawned process that survives its plugin is a leak, and on a
            // small host a reload loop of them is fatal.
            const detached = args.some((a) => a && typeof a === 'object' && a.detached === true);
            if (detached) {
              context.log.debug(`${bare}.${String(prop)} was detached, so it is left running on unload`);
              return created;
            }

            context.track(created);
            context.log.debug(`tracking ${bare}.${String(prop)}, it will be closed on unload`);
            return created;
          };
        },
      });
    };

    wrapped.resolve = (id) => {
      try {
        return real.resolve(id);
      } catch (e) {
        if (id.startsWith('.') || path.isAbsolute(id)) throw e;
        try {
          return fallback.resolve(id);
        } catch {
          return installed.resolve(id);
        }
      }
    };
    wrapped.cache = real.cache;
    wrapped.main = real.main;
    wrapped.extensions = real.extensions;
    return wrapped;
  }

  /**
   * Runs `npm install` inside a plugin own directory.
   * Only reached when PLUGIN_AUTO_INSTALL is on.
   */
  installDependencies(dir) {
    return this.runNpm(['install', '--omit=dev', '--no-audit', '--no-fund'], dir);
  }

  /**
   * npm's package name grammar, plus a length cap. Returns the normalised
   * spec, or null when it is not a package name.
   *
   * This is the gate that stops "axios; rm -rf /" reaching a shell. It is
   * belt-and-braces alongside spawn() being given an argument array rather than
   * a command string - either alone would be sufficient, but this is the layer
   * that produces a comprehensible error instead of a confusing npm one.
   */
  static validPackageSpec(spec) {
    const s = String(spec ?? '').trim();
    if (!s || s.length > 214) return null;
    const m = s.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._^~><=|\s*-]+))?$/);
    if (!m) return null;
    return m[2] ? `${m[1]}@${m[2]}` : m[1];
  }

  /**
   * Installs an npm package into the bot's own node_modules, so every plugin
   * can require it. Shared by /plugin npm and the web panel.
   */
  /**
   * Installs the packages named in PLUGINS_PACKAGES, skipping any already there.
   *
   * A plugin fetched from PLUGINS_URLS is a single file with no package.json, so
   * nothing declares what it needs and nothing can install it - on a host whose
   * data directory is wiped between runs that means re-running /plugin npm by
   * hand after every restart. This closes that loop: the packages are named in
   * the same place the plugin is.
   *
   * The resolve check matters more than it looks. npm on a small host is
   * expensive - measured at eighteen seconds and an eight second event-loop
   * stall on a tenth of a CPU - so paying it on every boot would be worse than
   * the problem. A container that already has the packages spawns nothing.
   */
  async ensurePackages(specs) {
    const wanted = (specs || []).map((s) => PluginHost.validPackageSpec(s)).filter(Boolean);
    if (!wanted.length) return { installed: [], skipped: [], ok: true };

    const from = [this.modulesDir.dir, this.bot.config.rootDir].map((d) => path.join(d, 'node_modules'));
    const present = (spec) => {
      // "name@1.2.3" and "@scope/name@1.2.3" both reduce to the bare name: a
      // version mismatch is not something this can see, and reinstalling on
      // every boot to check would defeat the point.
      const name = spec.startsWith('@') ? spec.split('@').slice(0, 2).join('@') : spec.split('@')[0];
      try {
        require.resolve(name, { paths: from });
        return true;
      } catch {
        return false;
      }
    };

    const missing = wanted.filter((s) => !present(s));
    const skipped = wanted.filter((s) => present(s));
    if (!missing.length) return { installed: [], skipped, ok: true };

    this.log.info(`installing ${missing.length} package(s) named in PLUGINS_PACKAGES: ${missing.join(', ')}`);
    const target = this.modulesDir;
    this.ensureNpmPrefix(target.dir);

    // One npm call for all of them: each spawn costs seconds on a small host.
    const result = await this.runNpm(
      ['install', ...missing, '--no-audit', '--no-fund', '--omit=dev', '--prefix', target.dir],
      target.dir,
    );

    if (!result.ok) {
      this.log.error(`could not install ${missing.join(', ')}: ${result.output.slice(-300)}`);
      return { installed: [], skipped, ok: false, error: result.output.slice(-300) };
    }
    return { installed: missing, skipped, ok: true };
  }

  async installNpmPackage(spec) {
    const valid = PluginHost.validPackageSpec(spec);
    if (!valid) {
      return { ok: false, code: -1, output: `"${spec}" is not a valid npm package name.` };
    }
    const target = this.modulesDir;
    try {
      this.ensureNpmPrefix(target.dir);
    } catch (e) {
      return { ok: false, code: -1, output: `cannot prepare ${target.dir}: ${e.message}` };
    }

    this.log.debug(`installing npm package ${valid} into ${target.dir} (${target.why})`);
    const result = await this.runNpm(
      ['install', valid, '--no-audit', '--no-fund', '--omit=dev', '--prefix', target.dir],
      target.dir,
    );
    this.log.debug(`npm install ${valid} exited ${result.code}`);
    if (result.ok && target.temporary) {
      this.log.warn(`${valid} went to ${target.dir} and will be gone after a restart`);
    }
    return { ...result, spec: valid, dir: target.dir, temporary: target.temporary, why: target.why };
  }

  /**
   * Where npm-installed packages go.
   *
   * Normally the project directory, beside discord.js, so there is one
   * node_modules and nothing to explain. But a container may mount the project
   * read-only with /tmp as the only writable place, and then installing into the
   * project is impossible rather than merely untidy. The order below prefers
   * permanence and degrades to somewhere that works, reporting which.
   *
   * Cached, because a plugin loaded at boot may need a package installed during
   * an earlier run, before any install has happened this time.
   */
  get modulesDir() {
    if (this._modulesDir) return this._modulesDir;
    const writable = require('./writable');

    const candidates = process.env.PLUGIN_MODULES_DIR
      ? [{ dir: path.resolve(process.env.PLUGIN_MODULES_DIR), why: 'PLUGIN_MODULES_DIR' }]
      : [
          { dir: this.bot.config.rootDir, why: 'the project directory' },
          { dir: path.join(this.bot.config.dataDir, 'npm'), why: 'the data directory' },
        ];

    for (const candidate of candidates) {
      if (writable.check(candidate.dir).ok) {
        this._modulesDir = { ...candidate, temporary: false };
        return this._modulesDir;
      }
    }

    // Last resort. Packages here do not survive a restart, which is a real
    // limitation rather than a detail, so every install says so.
    this._modulesDir = {
      dir: writable.scratchDir('npm'),
      why: 'a temporary directory, because nothing else was writable',
      temporary: true,
    };
    return this._modulesDir;
  }

  /**
   * npm walks up from --prefix looking for a package.json and will adopt one
   * belonging to a parent directory. Giving it its own stops an install into
   * /tmp from rewriting the bot's dependency list.
   */
  ensureNpmPrefix(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) return;
    fs.writeFileSync(
      manifest,
      JSON.stringify(
        { name: 'mulebot-plugin-modules', private: true, description: 'Packages installed with /plugin npm.' },
        null,
        2,
      ) + '\n',
    );
  }

  /**
   * Environment for a spawned npm.
   *
   * npm insists on a cache directory and derives it from HOME. Containers that
   * run as a non-root user routinely have a HOME that does not exist and cannot
   * be created - `USER node` in a slim image, or a PaaS assigning an arbitrary
   * uid - and npm then fails with an ENOENT on mkdir '/home/<user>/.npm' that
   * names the cache but reads like a network error:
   *
   *   Invalid response body while trying to fetch https://registry.npmjs.org/ws:
   *   ENOENT: no such file or directory, mkdir '/home/node/.npm'
   *
   * Pointing the cache somewhere writable is the whole fix. It is chosen the
   * same way plugin storage is: the data directory when that works, a scratch
   * directory when it does not.
   */
  npmEnv() {
    const writable = require('./writable');
    let base = path.join(this.bot.config.dataDir, '.npm');

    if (!writable.check(base).ok) {
      base = path.join(this.modulesDir.dir, '.npm-cache');
      if (!writable.check(base).ok) base = writable.scratchDir('npm-cache');
      this.log.debug(`npm cache falls back to ${base}; the data directory is not writable`);
    }

    return {
      ...process.env,
      // Both, because npm reads the config variable and some of its own
      // subprocesses still resolve paths from HOME.
      npm_config_cache: base,
      HOME: process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : path.dirname(base),
      // A missing update-notifier cache is another way to fail on a read-only
      // home, and the notice is noise in a bot log regardless.
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
  }

  /**
   * Runs npm with an argument array in `cwd`.
   * Never a shell string, so nothing in the arguments can be a separator.
   */
  runNpm(args, cwd, { timeoutMs = 180_000 } = {}) {
    return new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: this.npmEnv(),
      });

      let output = '';
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        resolve({ ok: code === 0, code, output: output.slice(-8000) });
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
        finish(-1);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        output += `\n[could not run npm: ${e.message}]`;
        finish(-1);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code);
      });
    });
  }

  /** Loads a native addon via process.dlopen. */
  loadNative(file) {
    const module_ = { exports: {} };
    const resolved = path.resolve(file);
    try {
      process.dlopen(module_, resolved);
      return module_.exports;
    } catch (e) {
      // The three failures worth naming, because the raw messages are cryptic.
      const message = e.message || String(e);
      if (/napi_register_module|Module did not self-register|no suitable image/i.test(message)) {
        throw new Error(
          `${path.basename(file)} is not a Node addon. process.dlopen only loads N-API/NAN addons built for Node ` +
            `(usually a .node file from node-gyp or prebuild), not an ordinary C shared library. Original error: ${message}`,
        );
      }
      if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) {
        throw new Error(
          `${path.basename(file)} was built for a different Node ABI than this runtime (${process.version}, ` +
            `modules ABI ${process.versions.modules}). Rebuild it against this Node version. Original error: ${message}`,
        );
      }
      if (/is not a valid Win32 application|wrong ELF class|incompatible architecture/i.test(message)) {
        throw new Error(
          `${path.basename(file)} was built for a different platform or architecture than this host ` +
            `(${process.platform}/${process.arch}). Original error: ${message}`,
        );
      }
      throw e;
    }
  }

  // ---------- writability ----------

  /**
   * Where an install may write.
   *
   * Unlike the data directory, relocating a plugin install is a reasonable
   * answer to a read-only filesystem: the code came from somewhere else and can
   * be fetched again, so a scratch copy is a working install rather than
   * silently discarded state. The one requirement is that it is *reported* —
   * every caller surfaces `temporary: true` so nobody is surprised when the
   * plugin is gone after a restart.
   *
   * @returns {{ dir: string, temporary: boolean }}
   */
  writableDir() {
    if (this._writableDir) return this._writableDir;

    const writable = require('./writable');
    if (writable.isWritable(this.dir)) {
      this._writableDir = { dir: this.dir, temporary: false };
      return this._writableDir;
    }

    const scratch = writable.scratchDir('plugins');
    this.log.warn(`${this.dir} is not writable, so installs go to ${scratch} instead`);
    this.log.warn('plugins installed there work now but do not survive a restart.');
    this.log.warn('to keep them, point DATA_DIR at a writable path or mount a volume.');
    this._writableDir = { dir: scratch, temporary: true };
    return this._writableDir;
  }

  // ---------- remote installation ----------

  /** The registry of plugins installed from a URL, kept in the data directory. */
  get remoteFile() {
    // Beside the plugin data rather than among the plugin files: this is a
    // record of what to fetch, not something anyone drops into a directory.
    return path.join(this.bot.config.dataDir, 'plugin-store', '_remote.json');
  }

  readRemotes() {
    try {
      return JSON.parse(fs.readFileSync(this.remoteFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Records the remote registry. Returns why it failed, or null on success.
   *
   * This must not throw. It used to, and the consequence was the worst possible
   * arrangement: the plugin had already downloaded and loaded by the time the
   * bookkeeping ran, so a write failure surfaced as "Install failed" for an
   * install that had in fact succeeded and was running. The registry is not the
   * install - losing it costs the ability to re-fetch on restart, nothing more,
   * and that is worth a warning rather than a lie.
   */
  writeRemotes(map) {
    try {
      fs.mkdirSync(path.dirname(this.remoteFile), { recursive: true });
      fs.writeFileSync(this.remoteFile, JSON.stringify(map, null, 2));
      return null;
    } catch (e) {
      // Returned, not logged. The caller puts it in the reply, where the person
      // who ran the command will actually read it.
      return `${e.code ? e.code + ': ' : ''}${e.message}`;
    }
  }

  /**
   * Downloads a URL with a size cap and a timeout.
   * @returns {Promise<{ buffer: Buffer, contentType: string, url: string }>}
   */
  async download(url, { maxBytes = 8 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('that is not a valid URL');
    }
    // https only. Plain http means anyone on the path decides what code this
    // process runs, and PLUGINS_URLS re-fetches on every boot - so a single
    // hostile network is permanent control of the host. There is no use for
    // which http is the right answer here.
    if (parsed.protocol !== 'https:') {
      throw new Error(
        parsed.protocol === 'http:'
          ? 'only https URLs can be installed: over http anyone on the network can replace the code that runs here'
          : 'only https URLs can be installed',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Redirects are followed by hand. `redirect: 'follow'` would check the
      // first URL and then obey wherever it is sent, which makes the address
      // check below decorative: a public URL can redirect to 169.254.169.254
      // and hand back the cloud provider's credentials.
      let current = parsed;
      let response;
      for (let hop = 0; hop < 5; hop++) {
        await assertPublicAddress(current);
        response = await fetch(current.href, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'user-agent': 'mulebot-plugin-installer' },
        });

        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) throw new Error(`the server sent a ${response.status} with no location`);
        current = new URL(location, current);
        if (current.protocol !== 'https:') throw new Error('the redirect left https, which is not followed');
        if (hop === 4) throw new Error('too many redirects');
      }

      if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`);

      const declared = Number(response.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) {
        throw new Error(`the file is ${Math.round(declared / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB limit`);
      }

      // content-length can lie or be absent, so the real cap is applied while
      // reading rather than trusted from the header.
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) {
          controller.abort();
          throw new Error(`the download exceeded the ${Math.round(maxBytes / 1024)} KB limit`);
        }
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      // An optional #sha256=... on the URL pins the content. Without it, a
      // URL fetched at every boot is only as trustworthy as whoever can change
      // what it serves - and the honest answer to "only use a URL you control"
      // is a way to say what you expected to find there.
      // parsed.hash is "#sha256=..." or empty, so slice(1) yields "" when absent.
      const pinned = /^sha256=([0-9a-f]{64})$/i.exec(parsed.hash.slice(1));
      if (pinned) {
        const expected = pinned[1].toLowerCase();
        const actual = require('node:crypto').createHash('sha256').update(buffer).digest('hex');
        if (actual !== expected) {
          throw new Error(`the file does not match the sha256 in the URL.\n  expected ${expected}\n  received ${actual}`);
        }
      }

      return {
        buffer,
        contentType: response.headers.get('content-type') || '',
        url: response.url || parsed.href,
        verified: Boolean(pinned),
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`the download timed out after ${timeoutMs / 1000}s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Derives a plugin name from a URL when none was given. */
  static nameFromUrl(url) {
    try {
      const base = path.basename(new URL(url).pathname) || 'remote-plugin';
      const stem = base.replace(/\.(js|cjs|zip|tar|tgz|gz)$/i, '').replace(/\.tar$/i, '');
      const cleaned = stem.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-._]+/, '');
      return cleaned || 'remote-plugin';
    } catch {
      return 'remote-plugin';
    }
  }

  /**
   * Installs a plugin from a URL.
   *
   * @param {string} url
   * @param {{ name?: string, mode?: 'persist'|'memory'|'once'|'ephemeral', remember?: boolean }} opts
   *   persist    write it into the plugins directory and load it (survives restart on disk)
   *   memory     never touch the disk; recorded so it is fetched again on restart
   *   once       download, load, and delete immediately - gone on restart
   *   ephemeral  whichever of the two leaves nothing behind, decided from the
   *              bytes: memory for a script, once for an archive. This is what
   *              PLUGINS_URLS uses, because the person writing a URL into an
   *              environment variable should not have to know which it serves.
   */
  async installFromUrl(url, opts = {}) {
    let mode = opts.mode || 'persist';
    const name = (opts.name || PluginHost.nameFromUrl(url)).replace(/[^A-Za-z0-9._-]/g, '-');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('invalid plugin name derived from that URL');

    if (this.plugins.get(name)?.state === 'loaded') await this.unload(name);

    const { buffer, url: finalUrl } = await this.download(url);
    const looksArchive = (() => {
      try {
        require('./archive').read(buffer);
        return true;
      } catch {
        return false;
      }
    })();

    // "ephemeral" means "leave nothing behind", not "never touch the disk", and
    // which of those is achievable depends on what arrived. A script really can
    // run from a string; a bundle needs a directory for its relative require()s
    // and its data files. So the choice is made here, once the bytes are in
    // hand, rather than forcing the caller to know in advance what a URL serves.
    if (mode === 'ephemeral') mode = looksArchive ? 'once' : 'memory';

    // ---- archive ----
    if (looksArchive) {
      if (mode === 'memory') {
        // A bundle needs a real directory: relative require()s resolve against
        // it, and files like an index.html are read from it by path. Faking that
        // would mean a virtual filesystem, which is a lot of fragile machinery
        // for a narrow case. "once" is the closest thing and is offered here so
        // the answer is not simply "no".
        throw new Error(
          'an archive cannot run purely from memory: a bundle needs a real directory for relative ' +
            'require() and for files it reads by path. Use mode "once" instead — it extracts, loads, ' +
            'then deletes the files, so nothing is left on disk and it is gone after a restart. ' +
            'Only a single .js file can run fully in memory.',
        );
      }
      const archive = require('./archive');
      const scratch = this.writableDir();
      const target = path.join(scratch.dir, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });

      const { files, stripped } = archive.extract(buffer, target);
      this.log.debug(`extracted ${files.length} file(s) into plugins/${name}${stripped ? ` (stripped "${stripped}/")` : ''}`);

      const resolved = PluginHost.resolveDirectory(target);
      if (!resolved) {
        fs.rmSync(target, { recursive: true, force: true });
        throw new Error('the archive has no index.js and no package.json "main", so there is nothing to load');
      }

      this.plugins.delete(name);
      const ok = await this.load({ name, file: resolved.file, kind: 'module', manifest: resolved.manifest });
      const loaded = this.plugins.get(name);
      if (loaded) loaded.origin = finalUrl;

      if (mode === 'once') {
        // Extracted, loaded, and now removed. The code stays live in this
        // process; nothing survives a restart. Anything the plugin read during
        // load is already in memory, but a file it opens lazily at request time
        // will be gone - which is why this is documented rather than silent.
        fs.rmSync(target, { recursive: true, force: true });
        if (loaded) loaded.ephemeral = true;
        this.log.debug(`removed plugins/${name}/ from disk; it runs until the next restart`);
        return {
          ok,
          name,
          mode: 'once',
          files: files.length,
          error: loaded?.error?.message,
          note: 'files deleted after loading',
        };
      }

      let recordError = null;
      if (ok && opts.remember !== false) {
        const remotes = this.readRemotes();
        remotes[name] = { url: finalUrl, mode: 'persist', kind: 'archive', at: Date.now() };
        recordError = this.writeRemotes(remotes);
      }
      return {
        ok,
        name,
        mode: 'persist',
        files: files.length,
        temporary: scratch.temporary,
        recordError,
        error: loaded?.error?.message,
      };
    }

    // ---- single script ----
    const source = buffer.toString('utf8');
    if (!source.trim()) throw new Error('the downloaded file is empty');

    if (mode === 'memory') {
      // Never written to disk. Recorded so a restart fetches it again.
      const virtualFile = path.join(this.bot.config.pluginsDir, `${name}.js`);
      this.plugins.delete(name);
      const ok = await this.load({ name, file: virtualFile, kind: 'script', source, origin: finalUrl });

      let recordError = null;
      if (ok && opts.remember !== false) {
        const remotes = this.readRemotes();
        remotes[name] = { url: finalUrl, mode: 'memory', kind: 'script', at: Date.now() };
        recordError = this.writeRemotes(remotes);
      }
      return { ok, name, mode: 'memory', recordError, error: this.plugins.get(name)?.error?.message };
    }

    const scratch = this.writableDir();
    const file = path.join(scratch.dir, `${name}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, 'utf8');

    this.plugins.delete(name);
    const ok = await this.load({ name, file, kind: 'script' });
    const plugin = this.plugins.get(name);
    if (plugin) plugin.origin = finalUrl;

    if (mode === 'once') {
      // Loaded, then the file is removed. The code stays live in this process
      // and is gone after a restart - useful for a one-off task or for trying
      // something without leaving it behind.
      fs.rmSync(file, { force: true });
      if (plugin) plugin.ephemeral = true;
      this.log.debug(`removed plugins/${name}.js from disk; it runs until the next restart`);
      return { ok, name, mode: 'once', error: plugin?.error?.message };
    }

    let recordError = null;
    if (ok && opts.remember !== false) {
      const remotes = this.readRemotes();
      remotes[name] = { url: finalUrl, mode: 'persist', kind: 'script', at: Date.now() };
      recordError = this.writeRemotes(remotes);
    }
    return { ok, name, mode: 'persist', temporary: scratch.temporary, recordError, error: plugin?.error?.message };
  }

  /**
   * Re-fetches every memory-mode plugin. Called once after the disk plugins
   * have loaded, because those are the ones that leave no trace on restart.
   */
  async restoreRemotes() {
    const remotes = this.readRemotes();
    const memoryOnes = Object.entries(remotes).filter(([, r]) => r.mode === 'memory');

    // Configured URLs are fetched on every boot, which is the only arrangement
    // that works on a host with no persistence: the remembered list above lives
    // in the plugins directory, and when that directory is a scratch path the
    // list is gone by the time it would be read. A URL in the environment or in
    // plugins.json survives because it is part of the deployment, not of the
    // container's disk.
    const configured = (this.manifest.urls || [])
      .map((u) => String(u).trim())
      .filter(Boolean)
      .filter((u) => !memoryOnes.some(([, r]) => r.url === u));

    if (!memoryOnes.length && !configured.length) return { restored: 0, failed: 0 };

    let restored = 0;
    let failed = 0;

    const fetchOne = async (url, name, label) => {
      try {
        // ephemeral, not memory: a .js runs from the string, an archive is
        // extracted, loaded and its directory removed. Either way nothing
        // survives the restart, which is what makes re-fetching correct.
        const result = await this.installFromUrl(url, { name, mode: 'ephemeral', remember: false });
        if (result.ok) {
          restored++;
          return;
        }
        failed++;
        this.log.warn(`could not load ${label} from ${url}: ${result.error}`);
      } catch (e) {
        failed++;
        this.log.warn(`could not load ${label} from ${url}: ${e.message}`);
      }
    };

    for (const [name, record] of memoryOnes) {
      await fetchOne(record.url, name, `in-memory plugin "${name}"`);
    }
    for (const url of configured) {
      // No name: installFromUrl derives one from the URL, the same as it does
      // for /plugin install.
      await fetchOne(url, undefined, 'configured plugin');
    }

    const from = [
      memoryOnes.length ? `${memoryOnes.length} remembered` : '',
      configured.length ? `${configured.length} configured` : '',
    ]
      .filter(Boolean)
      .join(' + ');
    this.log.debug(`loaded ${restored} plugin(s) from URLs (${from})${failed ? `, ${failed} failed` : ''}`);
    return { restored, failed };
  }

  /** Forgets a remote record, so a restart stops fetching it. */
  forgetRemote(name) {
    const remotes = this.readRemotes();
    if (!remotes[name]) return false;
    delete remotes[name];
    this.writeRemotes(remotes);
    return true;
  }

  /**
   * Installs from an uploaded buffer - the same paths as installFromUrl, minus
   * the download.
   */
  async installFromBuffer(buffer, { name, filename, mode = 'persist' } = {}) {
    const archive = require('./archive');
    // Two passes, because ".tar.gz" is two extensions: one pass leaves a plugin
    // called "mypkg.tar". nameFromUrl already did this; uploads did not, so the
    // same bundle got a different name depending on how it arrived.
    const stem = String(filename || 'uploaded')
      .replace(/\.(js|cjs|zip|tar|tgz|gz)$/i, '')
      .replace(/\.tar$/i, '');
    const derived = (name || stem).replace(/[^A-Za-z0-9._-]/g, '-');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(derived)) throw new Error('invalid plugin name');

    if (this.plugins.get(derived)?.state === 'loaded') await this.unload(derived);

    let isArchive = false;
    try {
      archive.read(buffer);
      isArchive = true;
    } catch {
      isArchive = false;
    }

    if (isArchive) {
      const target = path.join(this.writableDir().dir, derived);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      const { files, stripped } = archive.extract(buffer, target);

      const resolved = PluginHost.resolveDirectory(target);
      if (!resolved) {
        fs.rmSync(target, { recursive: true, force: true });
        throw new Error('the archive has no index.js and no package.json "main"');
      }
      this.plugins.delete(derived);
      const ok = await this.load({ name: derived, file: resolved.file, kind: 'module', manifest: resolved.manifest });
      return { ok, name: derived, files: files.length, stripped, error: this.plugins.get(derived)?.error?.message };
    }

    const source = buffer.toString('utf8');
    if (mode === 'memory') {
      const virtualFile = path.join(this.bot.config.pluginsDir, `${derived}.js`);
      this.plugins.delete(derived);
      const ok = await this.load({ name: derived, file: virtualFile, kind: 'script', source, origin: 'upload' });
      return { ok, name: derived, mode: 'memory', error: this.plugins.get(derived)?.error?.message };
    }

    const file = path.join(this.writableDir().dir, `${derived}.js`);
    fs.writeFileSync(file, source, 'utf8');
    this.plugins.delete(derived);
    const ok = await this.load({ name: derived, file, kind: 'script' });
    return { ok, name: derived, mode: 'persist', error: this.plugins.get(derived)?.error?.message };
  }

  // ---------- unloading ----------

  /**
   * Unloads a plugin and releases everything it held.
   * @returns {Promise<{ ok: boolean, error?: string, problems?: string[] }>}
   */
  async unload(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return { ok: false, error: `no plugin called "${name}"` };
    if (plugin.state !== 'loaded') return { ok: false, error: `"${name}" is not loaded (state: ${plugin.state})` };

    if (plugin.kind === 'native') {
      // Node exposes no dlclose, so a native addon stays in the process for
      // good. Saying so beats pretending the unload worked.
      return {
        ok: false,
        error:
          'native addons cannot be unloaded — Node has no dlclose binding. ' +
          'Disable it in plugins.json and restart the bot.',
      };
    }

    const problems = [];

    // A plugin's own unload() runs before the automatic teardown, so it can
    // still see the resources it is about to lose.
    const custom = plugin.exports?.unload || plugin.exports?.destroy;
    if (typeof custom === 'function') {
      try {
        await custom(plugin.context);
      } catch (e) {
        problems.push(`its own unload() threw: ${e.message}`);
      }
    }

    problems.push(...(await plugin.context.dispose()));

    plugin.state = 'pending';
    plugin.exports = null;

    // Drop anything the plugin pulled in through its own require, so a reload
    // picks up edits to its helper files too.
    const dir = path.dirname(plugin.file);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(dir + path.sep) || key === plugin.file) delete require.cache[key];
    }

    this.log.debug(`unloaded plugin "${name}"${problems.length ? ` with ${problems.length} problem(s)` : ''}`);
    return { ok: true, problems };
  }

  /** Unload then load again, picking up edits to the file. */
  /**
   * The URL a plugin came from, if it came from one.
   *
   * Checked in the live plugin first and the registry second, because a plugin
   * installed with mode "once" is recorded nowhere but still knows its origin.
   */
  sourceUrlFor(name) {
    const plugin = this.plugins.get(name);
    if (plugin?.origin) return plugin.origin;
    return this.readRemotes()[name]?.url || null;
  }

  /**
   * True when a plugin has no file to be reloaded from.
   *
   * A memory-mode plugin's `file` is a path that was never written: it exists
   * so error messages and relative requires have somewhere to point. Reading it
   * back is not a fallback, it is a guaranteed miss.
   */
  needsRefetch(plugin) {
    if (!plugin) return false;
    if (plugin.kind === 'memory') return true;
    return !fs.existsSync(plugin.file);
  }

  /**
   * Re-installs a plugin from the URL it came from.
   * Used wherever a reload would otherwise look for a file that is not there.
   */
  async refetch(name) {
    const plugin = this.plugins.get(name);
    const url = this.sourceUrlFor(name);
    if (!url) {
      return { ok: false, error: `"${name}" has no file and no source URL to fetch it from` };
    }

    // The mode it was installed with, so a re-fetch does not quietly turn an
    // in-memory plugin into one written to disk.
    const mode = plugin?.kind === 'memory' || plugin?.ephemeral ? 'memory' : 'persist';
    const result = await this.installFromUrl(url, { name, mode, remember: false });
    return result.ok ? { ok: true, refetched: url } : { ok: false, error: result.error || 'the re-fetch failed' };
  }

  async reload(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return { ok: false, error: `no plugin called "${name}"` };

    // Nothing on disk to re-read: go back to the URL rather than unloading a
    // working plugin and then deleting it for the crime of never having been a
    // file. installFromUrl handles the unload itself.
    if (this.needsRefetch(plugin)) return this.refetch(name);

    const entry = { name: plugin.name, file: plugin.file, kind: plugin.kind === 'native' ? 'native' : 'script' };

    if (plugin.state === 'loaded') {
      const result = await this.unload(name);
      if (!result.ok) return result;
    }
    if (!fs.existsSync(entry.file)) {
      this.plugins.delete(name);
      return { ok: false, error: 'the file no longer exists' };
    }

    this.plugins.delete(name);
    this.readManifest();
    const ok = await this.load(entry);
    const reloaded = this.plugins.get(name);
    return ok ? { ok: true } : { ok: false, error: reloaded?.error?.message || 'load failed' };
  }

  /**
   * Reloads every loaded plugin. Used when the gateway client is rebuilt during
   * the intent-fallback ladder, since plugin listeners were attached to the
   * client that has just been discarded.
   */
  async reloadAll() {
    const names = [...this.plugins.values()].filter((p) => p.state === 'loaded' && p.kind !== 'native').map((p) => p.name);
    for (const name of names) await this.reload(name).catch(() => {});
    return names.length;
  }

  /** Scans for files that appeared since boot and loads them. */
  async loadNew() {
    this.readManifest();
    const found = this.discover().filter((e) => !this.plugins.has(e.name));
    let loaded = 0;
    for (const entry of found) {
      if (this.manifest.ignored.includes(entry.name)) continue;
      if (await this.load(entry)) loaded++;
    }
    return { found: found.length, loaded };
  }

  // ---------- watching ----------

  /**
   * Watches the plugins directory and reloads on change.
   * Off by default: an editor writing a file in two chunks would otherwise
   * reload a half-written plugin, and fs.watch fires several times per save.
   */
  startWatching() {
    if (this.watcher) return false;
    if (!fs.existsSync(this.dir)) return false;

    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (ext !== '.js' && ext !== '.cjs' && !NATIVE_EXTENSIONS.has(ext)) return;
        if (filename.startsWith('.') || filename.startsWith('_')) return;

        const name = path.basename(filename, ext);
        // Debounce: a single save produces several events, and an editor may
        // truncate the file before writing it.
        clearTimeout(this.watchTimers.get(name));
        this.watchTimers.set(
          name,
          setTimeout(() => {
            this.watchTimers.delete(name);
            void this.onWatchEvent(name);
          }, 400),
        );
      });
      this.log.info(`watching ${this.dir} for changes`);
      return true;
    } catch (e) {
      // recursive watch is unsupported on some platforms and filesystems.
      this.log.warn(`could not watch the plugins directory: ${e.message}`);
      return false;
    }
  }

  async onWatchEvent(name) {
    const known = this.plugins.get(name);

    if (known && !fs.existsSync(known.file)) {
      await this.unload(name);
      this.plugins.delete(name);
      await this.syncCommands();
      return;
    }
    if (known) {
      this.log.info(`change detected in "${name}", reloading`);
      await this.reload(name);
    } else {
      this.log.info(`new plugin file "${name}", loading`);
      await this.loadNew();
    }
    await this.syncCommands();
  }

  stopWatching() {
    if (!this.watcher) return false;
    this.watcher.close();
    this.watcher = null;
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    return true;
  }

  // ---------- housekeeping ----------

  /** Re-registers commands with Discord if a plugin added or removed any. */
  async syncCommands() {
    if (!this.commandsDirty) return false;
    this.commandsDirty = false;
    if (!this.bot.readyAt) return false; // clientReady will register them anyway
    await this.bot.registerCommands();
    return true;
  }

  /** Snapshot for /plugin list and /stats. */
  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      state: p.state,
      kind: p.kind,
      file: path.relative(this.dir, p.file),
      version: p.version,
      description: p.description,
      loadedAt: p.loadedAt,
      error: p.error ? p.error.message : null,
      owned: p.context ? p.context.describe() : null,
    }));
  }

  get(name) {
    return this.plugins.get(name) || null;
  }

  stats() {
    const all = [...this.plugins.values()];
    return {
      total: all.length,
      loaded: all.filter((p) => p.state === 'loaded').length,
      failed: all.filter((p) => p.state === 'failed').length,
      disabled: all.filter((p) => p.state === 'disabled').length,
      watching: Boolean(this.watcher),
    };
  }

  /** Unloads everything, used on shutdown. */
  async disposeAll() {
    this.stopWatching();
    for (const plugin of this.plugins.values()) {
      if (plugin.state !== 'loaded' || plugin.kind === 'native') continue;
      await this.unload(plugin.name).catch(() => {});
    }
  }
}

module.exports = { PluginHost, PluginContext, Plugin, NATIVE_EXTENSIONS, isInternalAddress };
