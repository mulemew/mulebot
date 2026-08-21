# Plugins

Drop a `.js` file in this directory. It loads on the next start, or immediately
with `/plugin scan`.

```
plugins/
  healthz.js        health endpoint for platforms that require one — DISABLED
  plugins.json      optional: disable plugins, pass config, list URLs
```

A fresh install opens no port and adds no commands: the one bundled plugin
ships disabled. Anything you drop in yourself loads normally.

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

That is a complete, working plugin.

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

## healthz — for platforms that require a listening port

Some hosts classify a deployment as a *web* service and restart it when nothing
listens on the port they inject. `healthz.js` is bundled for that, and **ships
disabled** because a Discord bot has no reason to serve a port. Turn it on where
you need it:

```ini
PLUGINS_ALLOW=healthz
```

It binds `0.0.0.0:$PORT` when the platform injects one, localhost otherwise, and
answers on `/healthz`, `/health` and `/`.

### What it checks

"The process is alive" is what a TCP connection already proves, and it is nearly
worthless — a bot whose gateway died an hour ago still accepts connections. So
the status code reflects whether the bot is doing its job:

| | |
|---|---|
| **200** | gateway connected, event loop responsive |
| **503** | still starting, gateway down past the grace period, or the event loop stalling past the interaction deadline |

```json
{
  "status": "degraded",
  "uptimeMs": 41221,
  "gatewayPingMs": 138,
  "rssMb": 119,
  "checks": {
    "started":   { "ok": true,  "detail": "gateway has connected" },
    "gateway":   { "ok": true,  "detail": "connected" },
    "eventLoop": { "ok": false, "detail": "worst stall 9000ms of 3000ms allowed" }
  }
}
```

503 while starting is deliberate: a platform that waits for healthy should wait,
and one that restarts on repeated failure should not restart a bot three seconds
from ready. A gateway drop is tolerated for `HEALTHZ_GATEWAY_GRACE_MS`
(default 120s) so a Discord hiccup does not become a restart loop.

| Setting | Default |
|---|---|
| `PORT` | 3000, and binding `0.0.0.0` when set |
| `HEALTHZ_PORT`, `HEALTHZ_HOST` | override either |
| `HEALTHZ_GATEWAY_GRACE_MS` | `120000` |
| `HEALTHZ_MAX_LAG_MS` | `3000`, Discord's interaction deadline |

The body carries no server names, ids or member counts: on a PaaS this is a
public URL with nothing in front of it.

**If the platform's check is `type: tcp`** it opens a socket and closes it
without reading the status, so none of the above is consulted and any listener
would do. Point an HTTP check at `/healthz` to get the real answer.

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

**https only.** Over plain http anyone on the network path chooses what code
this process runs, and with `PLUGINS_URLS` that happens again at every restart.
There is no case where http is the right answer, so it is refused outright.

**Only public addresses.** The resolved IP is checked before each request, and
again for every redirect: loopback, private ranges and link-local are refused.
That last one matters most — `169.254.169.254` is where a cloud host serves
instance credentials to anything that asks.

**Pin the content if you like.** A `#sha256=` fragment is verified against what
arrived, so a changed file fails to load instead of running:

```
PLUGINS_URLS=https://example.com/p.js#sha256=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
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
plugin.name                       // "port"
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
  "disabled": ["noisy"],
  "config": {
    "port": { "bind": "0.0.0.0" }
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

## Turning plugins on and off

`plugins/plugins.json` lists names to skip in `disabled`. Where that file cannot
be edited — a read-only project directory, which is normal on a PaaS — the same
switches are environment variables:

| | |
|---|---|
| `PLUGINS_DISABLED` | comma-separated names to skip |
| `PLUGINS_ALLOW` | names to load even though `plugins.json` disables them |
| `PLUGINS_ENABLED=false` | the master switch: load nothing at all |

A name in both lists loads. The boot log says which variable acted.

## Native code: two different things called .so

`.node`, `.so`, `.dll` and `.dylib` dropped into the plugins directory are loaded
with `process.dlopen`. That only works for a **Node addon** — something built
against Node's own API with node-gyp or prebuild. The extension does not decide
this; how the library was built does.

An **ordinary C shared library** cannot be loaded that way, and the bot says so
rather than failing cryptically:

```
libfoo.so is not a Node addon. process.dlopen only loads N-API/NAN addons
built for Node, not an ordinary C shared library.
```

For those, use an FFI from inside a normal `.js` plugin. `koffi` needs no build
step — it ships prebuilt binaries for 18 platforms, so it installs even where
build scripts are blocked:

```js
const koffi = require('koffi');

const lib = koffi.load('/path/to/libfoo.so');
plugin.track(lib);                     // released on unload

const add = lib.func('int add(int, int)');
plugin.log.info('2 + 3 = ' + add(2, 3));
```

Install it with `/plugin npm package:koffi`, or put it in the plugin folder's
own `package.json`.

`plugin.track(lib)` matters: without it the library stays mapped into the
process after the plugin unloads, and every reload maps it again.

## What gets cleaned up for you

A plugin does not have to write cleanup code. Unloading it reclaims:

| | |
|---|---|
| Timers | `setTimeout`, `setInterval`, `setImmediate` |
| Servers | `createServer` from `http`, `https`, `http2`, `net`, `tls` — the port is released |
| Child processes | `spawn`, `fork`, `exec`, `execFile` — killed |
| Listeners, commands, buttons, scheduled tasks | anything registered through `plugin` |

The one exception is deliberate: a child spawned with `detached: true` is left
running, because that flag is the only way to say the process is meant to
outlive its parent.

Anything the host cannot see — a database driver's connection pool, a
third-party client — hand to `plugin.track(resource)`, which closes it the same
way.

## Loading from a URL on a host with no disk

A container that mounts the project read-only, or gives you only `/tmp`, loses
anything installed through `/plugin install` when it restarts. Listing the URL
in the configuration instead makes it part of the deployment:

```ini
PLUGINS_URLS=https://example.com/myplugin.js,https://example.com/tools.zip
```

or in `plugins/plugins.json`:

```json
{ "urls": ["https://example.com/myplugin.js"] }
```

Each is fetched at boot, loaded into memory, and never written to disk — so the
next restart fetches it again. Plain `.js`, `.zip` and `.tar.gz` all work, and
the plugin name comes from the filename in the URL.

The fetched code runs inside the bot process with the bot's privileges. Only
list URLs you control: whoever can change what that URL serves can run anything
they like here, and a restart is all it takes.
