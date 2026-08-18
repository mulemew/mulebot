# Plugins

Drop a `.js` file in this directory. It loads on the next start, or immediately
with `/plugin scan`.

```
plugins/
  httpserver.js     standalone script example — starts a status endpoint
  hello.js          full-contract example — command, button, storage, task
  plugins.json      optional: disable plugins, pass config

Both examples are DISABLED by default, so a fresh install opens no port and
adds no commands. Enable one with /plugin load, or remove its name from
"disabled" in plugins.json. Your own plugins are unaffected — anything not
named there loads normally.
```

---

## The two styles

### 1. A standalone script

No exports, no contract. The file runs when it loads, the same as
`node plugins/whatever.js`.

```js
// plugins/ticker.js
const fs = require('node:fs');

setInterval(() => {
  fs.appendFileSync('tick.log', `${new Date().toISOString()}\n`);
}, 60_000);

console.log('ticker started');
```

That is a complete, working plugin. `plugins/httpserver.js` is a real one.

### 2. A module with `init()`

Export `init(plugin)` to get a context object with the bot and the registration
hooks.

```js
// plugins/greet.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  version: '1.0.0',
  description: 'Adds /greet',

  init(plugin) {
    plugin.registerCommand({
      data: new SlashCommandBuilder().setName('greet').setDescription('Say hi'),
      category: 'plugin',
      async execute(ctx) {
        return ctx.send('Hi.');
      },
    });
  },

  async unload(plugin) {
    plugin.log.info('bye');
  },
};
```

`plugins/hello.js` is a working version of this with everything wired up.

The two styles mix: a script can call `plugin.registerCommand()` at top level
without exporting anything.

---

## What JS is accepted

**Plugins are CommonJS.** Any CommonJS file works — there is no sandbox, no
allow-list of modules, no API restriction. A plugin can do anything the bot
process can do.

Tested, and enforced by the test suite:

| | | |
|---|---|---|
| ✅ | plain synchronous script | `setInterval(...)`, no exports needed |
| ✅ | `require()` of anything | core modules, npm packages, your own files |
| ✅ | `module.exports = { init(plugin) {} }` | the module contract |
| ✅ | `async init(plugin)` | await freely inside it |
| ✅ | `await plugin.import('esm-pkg')` | **portable**, works on every Node version |
| ✅ | `await import('esm-pkg')` | native, needs Node ≥ 20.10 |
| ❌ | `import x from 'x'` | ESM syntax — use `require()` |
| ❌ | `export const x` | use `module.exports` |
| ❌ | top-level `await` | move it into `async init()` |

The three unsupported forms all produce an error that names the fix rather than
repeating V8's wording:

```
esm-import.js uses ESM syntax, but plugins are CommonJS.
Use "const x = require('x')" instead of "import x from 'x'", and
"module.exports = {...}" instead of "export".
To load an ESM-only package, use "await plugin.import('pkg')" inside an async init().
```

To use an ESM-only npm package:

```js
module.exports = {
  async init(plugin) {
    const { default: chalk } = await plugin.import('chalk');
    plugin.log.info(chalk.green('works'));
  },
};
```

## Dependencies

A plugin's npm packages are **not** installed for you. Four cases, all tested:

| What the plugin requires | Works? | Why |
|---|---|---|
| `require('node:http')` | ✅ | core modules, always available |
| `require('discord.js')` | ✅ | the bot's own dependencies are on the resolution path |
| `require('./lib/helper')` | ✅ | resolves next to the plugin file |
| `require('axios')` | ❌ until installed | nothing installs it automatically |

Two ways to add one:

**Install it alongside the bot** — simplest, shared by every plugin:

```bash
npm install axios          # in the bot's root directory
```

**Or keep it with the plugin** — better when a plugin has heavy or
version-specific dependencies, and it travels as one folder:

```
plugins/
  myplugin/
    index.js               ← the entry point; the folder becomes one plugin
    package.json
    node_modules/
      axios/
```

```bash
cd plugins/myplugin && npm install
```

A directory containing `index.js` is loaded as a **single** plugin, so its
helper files and `node_modules` are never mistaken for plugins of their own.

If a package is missing, the error names both fixes rather than leaving you with
Node's default message (which points confusingly at the bot's `index.js`):

```
Cannot find module 'axios'. A plugin's dependencies are not installed automatically.
  Install it for every plugin:  npm install axios   (in /opt/mulebot)
  Or keep it with this plugin:  make myplugin a directory with its own
  package.json and node_modules, and an index.js entry point.
```

Note for Docker: the image copies `plugins/` at build time. Mount it as a volume
(`./plugins:/app/plugins`) to add plugins without rebuilding — but a plugin with
its own `node_modules` then needs those installed on the host, for the
container's platform.

## Installing from a URL or an archive

Three persistence modes, because "try this plugin" and "install this plugin" are
different things:

| Mode | On disk? | After a restart |
|---|---|---|
| `persist` | written to `plugins/` | still there, loaded normally |
| `once` | written, loaded, then **deleted** | gone |
| `memory` | **never written** | re-fetched from its URL |

```js
await bot.plugins.installFromUrl('https://example.com/p.js', { mode: 'memory' });
```

`memory` mode records only the URL, in `data/plugins/_remote.json`, and fetches
it again on every start — so the code exists on disk nowhere, and updating the
plugin means updating the file it is served from.

Archives (`.zip`, `.tar`, `.tar.gz`) install into a directory. When every entry
shares one top-level folder — what GitHub's "Download ZIP" produces — that
wrapper is stripped, so `myplugin-main/index.js` becomes `myplugin/index.js`.

The archive readers are written directly against zlib rather than pulling in a
dependency, and every entry path is validated before anything is written: an
entry named `../../etc/cron.d/x` ("zip slip") is discarded, not extracted.
Downloads are capped at 8 MB, uploads at 16 MB, and an archive that expands past
64 MB is rejected as a decompression bomb.

## Taking effect immediately

With `PLUGIN_WATCH=true` the directory is watched and changes apply within
about a second, with no restart:

| You do | What happens |
|---|---|
| drop in a `.js` file | discovered and loaded |
| edit a loaded plugin | unloaded and reloaded from disk |
| **delete the file** | **unloaded, its port/timers released, removed from the list** |

Without the watcher (the default), use `/plugin scan` for new files and
`/plugin reload` after an edit. The watcher is off by default because an editor
that saves in two chunks will get a half-written file loaded — fine while
developing, bad in production.

Deleting a file **only** cleans up when the watcher is on. Without it, the
plugin keeps running until you `/plugin unload` it or restart; removing a file
from disk does not by itself stop code that is already in memory.

## What you get for free

Plugin files are not loaded with plain `require`. Each is compiled with extra
parameters that shadow the globals in that file's scope, which means:

| You write | What actually happens |
|---|---|
| `setInterval(...)` / `setTimeout(...)` | tracked, cleared on unload |
| `require('http').createServer()` | server is tracked, port closed on unload |
| `console.log('x')` | goes to the bot's logger tagged `[plugin:name]` |
| `plugin` (undeclared) | the context object, always in scope |
| `require('discord.js')` | resolves against the bot's `node_modules` |
| `require('./helper')` | resolves next to your plugin file |

So a plugin that opens a port and ticks a timer needs no cleanup code at all —
`/plugin unload` releases both.

Anything the host cannot see — a database pool, a third-party client — should be
handed over explicitly:

```js
const pool = plugin.track(createPool(), (p) => p.end());
```

---

## Logging

A plugin does **not** manage its own logs. Everything goes through the bot's
logger, tagged with the plugin name, and inherits every limit the bot's logging
has — the 500-line ring buffer, the `LOG_FILE` size cap, the panel's stdout.

```js
plugin.log.info('hello');   // → 12:01:48 INFO [bot:plugin:myplugin] hello
console.log('hello');       // → identical: console is rerouted inside a plugin
```

So there is no per-plugin log file to rotate and no way for a chatty plugin to
grow the log beyond the configured ceiling. `LOG_LEVEL` applies to plugins too,
and `/owner loglevel` changes them at runtime along with everything else.

The one thing outside this: a plugin that writes its own file directly
(`fs.appendFileSync('my.log', ...)`) is on its own — the host cannot see or cap
that. Use `plugin.log` unless you specifically want a separate file.

## The `plugin` context

```js
plugin.name                       // "httpserver"
plugin.file, plugin.dir           // absolute paths
plugin.bot                        // the Bot instance: db, features, scheduler, client
plugin.log                        // scoped logger: .info .warn .error .debug
plugin.config                     // this plugin's entry from plugins.json
plugin.store                      // persistent JSON store, data/plugins/<name>.json
plugin.import(specifier)          // load an ESM-only package, portable

plugin.track(resource, closer?)   // close it on unload
plugin.addCleanup(fn)             // run fn on unload (reverse order)
plugin.on(emitter, event, fn)     // listener, removed on unload
plugin.onDiscord(event, fn)       // shorthand for on(bot.client, ...)
plugin.onReady(fn)                // when the gateway connects, or now if already up

plugin.registerCommand(command)   // slash command, same shape as src/commands/*
plugin.registerComponent(ns, fn)  // buttons/selects/modals whose id starts "ns:"
plugin.registerTask(type, fn)     // persistent scheduled-task handler
plugin.schedule(type, runAt, data)

plugin.setTimeout / setInterval / setImmediate / clearTimer
```

`plugin.store` is the same store the bot uses internally:

```js
plugin.store.get('count', 0);
plugin.store.set('user.123.seen', Date.now());
plugin.store.add('count', 1);        // returns the new value
plugin.store.push('log', entry, { max: 100 });
```

Writes are debounced and atomic; a crash cannot leave a half-written file.

---

## Managing plugins

Owner-only, because a plugin runs with the bot's full privileges.

```
/plugin list                 every plugin, its state and what it holds
/plugin info name:hello      details, resources held, last error with stack
/plugin load name:hello
/plugin unload name:hello    releases ports, timers, listeners, commands
/plugin reload name:hello    picks up edits to the file
/plugin scan                 find newly added files
/plugin watch enabled:true   auto-reload on change (development only)
```

Commands added or removed by a plugin are re-registered with Discord
automatically.

---

## `plugins.json`

Entirely optional.

```json
{
  "disabled": ["httpserver"],
  "config": {
    "httpserver": { "port": 8080, "host": "0.0.0.0" }
  }
}
```

---

## Native addons (`.node`, `.so`)

A `.node` / `.so` / `.dll` / `.dylib` file in this directory is loaded with
`process.dlopen`.

**It must be a Node addon** — built with node-gyp, prebuild, napi-rs, neon or
similar, exporting `napi_register_module_v1`. An ordinary C shared library
(libfoo.so) is not loadable this way and never will be; Node has no FFI built
in. For those, use a Node binding package on npm, or write a small N-API
wrapper.

The addon must also match this runtime:

- **ABI**: built for Node's module version `process.versions.modules`
- **Platform and architecture**: `process.platform` / `process.arch`

All three failure modes produce a specific error message rather than a raw
`dlopen` string, so you can tell which one you hit.

An addon can export `init(plugin)` just like a JS plugin.

**Native addons cannot be unloaded.** Node exposes no `dlclose`, so the library
stays in the process for its lifetime. `/plugin unload` refuses rather than
pretending; disable it in `plugins.json` and restart.

---

## Failure behaviour

- A plugin that throws while loading is marked `failed`; the bot carries on and
  `/plugin info` shows the stack.
- Resources it opened before throwing are released.
- A plugin that throws inside a timer or listener logs the error and does not
  take down the process.
- One broken plugin never prevents the others, or the bot, from starting.

---

## Trust

A plugin runs **inside the bot process, with the bot's privileges**. It can read
the token, the data directory and the filesystem, and open sockets. The compile
wrapper exists for clean unloading, not isolation — `vm` is not a security
boundary and this host does not pretend it is.

Installing a plugin is exactly as consequential as editing the bot's source.
Only run code you have read or trust. On a host where this directory is not
exclusively yours, set `PLUGINS_ENABLED=false`.

## webpanel.js

A browser UI for managing plugins: upload, install from npm or a URL, load,
unload, view logs. Ships enabled, but **refuses to start until a credential is
set** — so it does nothing on a fresh clone.

Generate a verifier, which keeps the secret off the host entirely:

```bash
node plugins/webpanel.js --hash
```

Put the printed `scrypt$...` string in `WEBPANEL_TOKEN_HASH`, or in
`plugins.json` as `config.webpanel.tokenHash`. A plaintext `WEBPANEL_TOKEN` of at
least 24 characters also works and warns.

### Where it listens

| | Port | Interface |
|---|---|---|
| Platform injected `PORT` | that port | `0.0.0.0` |
| Otherwise | `WEBPANEL_PORT`, else 8787 | `127.0.0.1` |

`config.port` and `config.host` in `plugins.json` override both.

Following `PORT` is what makes this usable on a PaaS: a host that injects it
will not keep a service alive without a listener on it, and a panel bound to
localhost there is both unreachable and useless for that.

**Understand what that means.** On a PaaS the panel is on the service's public
URL, and it runs uploaded code inside the bot process — the credential is
equivalent to a shell on that host. Failed attempts are rate-limited and lock
out, the secret is exchanged for a session token at login, and only a scrypt
verifier is stored. A long random secret is still doing most of the work.

If all you need is for the platform to see a listening port, `httpserver.js` is
the smaller target: same `PORT` rule, but it only reports status and has no way
to change anything.
