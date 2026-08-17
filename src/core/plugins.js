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
const CLOSERS = ['close', 'destroy', 'stop', 'kill', 'disconnect', 'end', 'terminate'];

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

  /** Lazily-created persistent storage, at data/plugins/<name>.json. */
  get store() {
    if (!this._store) {
      const dir = path.join(this.bot.config.dataDir, 'plugins');
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
            const returned = resource[method](done);
            if (returned && typeof returned.then === 'function') returned.then(done, done);
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
    this.manifest = { disabled: [], config: {} };
  }

  // ---------- discovery ----------

  /** Reads plugins/plugins.json, which is optional. */
  readManifest() {
    const file = path.join(this.dir, 'plugins.json');
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.manifest = {
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
      };
    } catch (e) {
      this.log.warn(`plugins.json is unreadable, ignoring it: ${e.message}`);
    }
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
          // A directory plugin is loaded through its index.js, so its helper
          // files are not each loaded as separate plugins.
          const index = ['index.js', 'index.cjs'].map((f) => path.join(full, f)).find((f) => fs.existsSync(f));
          if (index) {
            out.push({ name: entry.name, file: index, kind: 'module' });
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
      this.log.info('no plugins found');
      return { loaded: 0, failed: 0, disabled: 0 };
    }

    let loaded = 0;
    let failed = 0;
    let disabled = 0;

    for (const entry of found) {
      if (this.manifest.disabled.includes(entry.name)) {
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
      plugin.exports = entry.kind === 'native' ? this.loadNative(entry.file) : this.compileAndRun(entry.file, context);

      // Metadata is optional; a bare script has none.
      const exported = plugin.exports || {};
      plugin.meta = {
        version: exported.version,
        description: exported.description,
        author: exported.author,
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
    const source = fs.readFileSync(file, 'utf8');
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
    // Second resolver rooted at the bot itself. PLUGINS_DIR can point anywhere,
    // and Node resolves node_modules by walking up from the importing file - so
    // a plugin outside the project tree could not require('discord.js') without
    // this fallback. Relative and absolute ids are never redirected, since those
    // are the plugin's own files and a silent substitution would be worse than
    // the error.
    const fallback = Module.createRequire(path.join(this.bot.config.rootDir, 'index.js'));

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
          // Node's own message ends with a require stack pointing at the bot's
          // index.js - an artefact of the fallback resolver above, and actively
          // misleading to someone whose plugin is missing a package. Replace it
          // with the two places that would actually fix it.
          const err = new Error(
            `Cannot find module '${id}'. A plugin's dependencies are not installed automatically.\n` +
              `  Install it for every plugin:  npm install ${id}   (in ${this.bot.config.rootDir})\n` +
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
      if (bare !== 'http' && bare !== 'https' && bare !== 'net' && bare !== 'tls' && bare !== 'http2') return loaded;

      // A Proxy keeps every other export intact, including lazy getters.
      return new Proxy(loaded, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if ((prop === 'createServer' || prop === 'createSecureServer') && typeof value === 'function') {
            return (...args) => {
              const server = value.apply(target, args);
              context.track(server);
              context.log.debug(`tracking a ${bare} server, it will be closed on unload`);
              return server;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    wrapped.resolve = (id) => {
      try {
        return real.resolve(id);
      } catch (e) {
        if (id.startsWith('.') || path.isAbsolute(id)) throw e;
        return fallback.resolve(id);
      }
    };
    wrapped.cache = real.cache;
    wrapped.main = real.main;
    wrapped.extensions = real.extensions;
    return wrapped;
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

    this.log.info(`unloaded plugin "${name}"${problems.length ? ` with ${problems.length} problem(s)` : ''}`);
    return { ok: true, problems };
  }

  /** Unload then load again, picking up edits to the file. */
  async reload(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return { ok: false, error: `no plugin called "${name}"` };

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
      if (this.manifest.disabled.includes(entry.name)) continue;
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

module.exports = { PluginHost, PluginContext, Plugin, NATIVE_EXTENSIONS };
