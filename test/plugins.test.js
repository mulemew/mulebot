'use strict';

/**
 * Plugin host integration tests.
 *
 * These boot a real Bot (without logging in) against a throwaway plugins
 * directory, because the interesting behaviour is exactly the part that unit
 * tests cannot see: whether a port is genuinely released, whether a broken
 * plugin takes anything else down, whether an unloaded plugin really stops.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const discord = require('discord.js');
const Bot = require('../src/bot');

const ROOT = path.join(__dirname, '..');

/** A free-ish high port, offset per test so parallel runs do not collide. */
let nextPort = 34_500 + (process.pid % 500);
const takePort = () => nextPort++;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Boots a bot pointed at a scratch plugins and data directory. */
async function boot(pluginsDir) {
  process.env.PLUGINS_DIR = pluginsDir;
  process.env.DATA_DIR = tempDir('bot-data-');
  process.env.LOG_LEVEL = 'silent';
  process.env.REGISTER_COMMANDS = 'false';

  const bot = new Bot({ token: 'x.y.z', rootDir: ROOT, discord });
  await bot.init();
  return bot;
}

const get = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });

// ---------------------------------------------------------------------------

test('a standalone script plugin runs, and unloading frees its port', async (t) => {
  const dir = tempDir('bot-plugins-');
  const port = takePort();

  fs.writeFileSync(
    path.join(dir, 'server.js'),
    `
    const http = require('node:http');
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('alive'); });
    server.listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
    `,
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plugin = bot.plugins.get('server');
  assert.equal(plugin.state, 'loaded');
  assert.equal(plugin.kind, 'script', 'a file with no exports is a script plugin');

  // Give listen() a moment; it is asynchronous.
  await new Promise((r) => setTimeout(r, 300));

  const response = await get(`http://127.0.0.1:${port}/`);
  assert.equal(response.body, 'alive', 'the plugin should be serving');

  // Both the server and the interval must have been tracked with no help from
  // the plugin - that is the whole point of the compile wrapper.
  const owned = plugin.context.describe();
  assert.ok(owned.resources >= 1, 'the http server should have been auto-tracked');
  assert.ok(owned.timers >= 1, 'setInterval should have been auto-tracked');

  const result = await bot.plugins.unload('server');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.problems, [], 'teardown should report no problems');

  // The regression this guards: closeAllConnections() was once treated as a
  // shutdown method, which drops sockets but leaves the listener bound. Unload
  // reported success and the port stayed held.
  assert.equal(await portFree(port), true, 'the port must actually be free after unload');
  await assert.rejects(() => get(`http://127.0.0.1:${port}/`), 'the server must stop answering');
});

test('a module plugin registers and unregisters everything it owns', async (t) => {
  const dir = tempDir('bot-plugins-');

  fs.writeFileSync(
    path.join(dir, 'thing.js'),
    `
    const { SlashCommandBuilder } = require('discord.js');
    module.exports = {
      version: '2.1.0',
      description: 'test fixture',
      init(plugin) {
        plugin.registerCommand({
          data: new SlashCommandBuilder().setName('fixture').setDescription('test'),
          async execute(ctx) { return ctx.send('hi'); },
        });
        plugin.registerComponent('fixturens', async () => {});
        plugin.registerTask('fixture_task', async () => {});
        plugin.store.set('loaded', true);
        plugin.setInterval(() => {}, 5000);
      },
      async unload(plugin) { plugin.store.set('unloaded', true); },
    };
    `,
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plugin = bot.plugins.get('thing');
  assert.equal(plugin.state, 'loaded');
  assert.equal(plugin.kind, 'module', 'exporting init() makes it a module plugin');
  assert.equal(plugin.version, '2.1.0');
  assert.equal(plugin.description, 'test fixture');

  assert.ok(bot.registry.has('fixture'), 'the command should be registered');
  assert.equal(bot.registry.get('fixture').file, 'plugin:thing');
  assert.ok(bot.components.has('fixturens'), 'the component route should be registered');
  assert.ok(bot.scheduler.handlers.has('fixture_task'), 'the task handler should be registered');
  assert.equal(plugin.context.store.get('loaded'), true, 'the plugin store should persist');

  const result = await bot.plugins.unload('thing');
  assert.equal(result.ok, true, result.error);

  assert.equal(bot.registry.has('fixture'), false, 'the command must be gone');
  assert.equal(bot.components.has('fixturens'), false, 'the component route must be gone');
  assert.equal(bot.scheduler.handlers.has('fixture_task'), false, 'the task handler must be gone');
});

test('a broken plugin fails alone and does not stop the others', async (t) => {
  const dir = tempDir('bot-plugins-');

  fs.writeFileSync(path.join(dir, 'syntax.js'), 'this is not ( valid javascript');
  fs.writeFileSync(path.join(dir, 'throws.js'), 'throw new Error("deliberate failure");');
  fs.writeFileSync(
    path.join(dir, 'inits-badly.js'),
    'module.exports = { init() { throw new Error("init exploded"); } };',
  );
  fs.writeFileSync(path.join(dir, 'fine.js'), 'plugin.store.set("ok", true);');

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.get('syntax').state, 'failed');
  assert.match(bot.plugins.get('syntax').error.message, /syntax error/i);

  assert.equal(bot.plugins.get('throws').state, 'failed');
  assert.match(bot.plugins.get('throws').error.message, /deliberate failure/);

  assert.equal(bot.plugins.get('inits-badly').state, 'failed');
  assert.match(bot.plugins.get('inits-badly').error.message, /init exploded/);

  // The healthy one still loaded, which is the actual requirement.
  assert.equal(bot.plugins.get('fine').state, 'loaded');

  const stats = bot.plugins.stats();
  assert.equal(stats.failed, 3);
  assert.equal(stats.loaded, 1);
});

test('a plugin that throws after opening a port still releases it', async (t) => {
  const dir = tempDir('bot-plugins-');
  const port = takePort();

  fs.writeFileSync(
    path.join(dir, 'halfway.js'),
    `
    const http = require('node:http');
    http.createServer().listen(${port}, '127.0.0.1');
    throw new Error('failed after binding');
    `,
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.get('halfway').state, 'failed');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await portFree(port), true, 'a failed load must not leak the port it opened');
});

test('reload picks up edits to the file', async (t) => {
  const dir = tempDir('bot-plugins-');
  const file = path.join(dir, 'versioned.js');

  fs.writeFileSync(file, 'module.exports = { version: "1.0.0", init(plugin) { plugin.store.set("v", 1); } };');

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.get('versioned').version, '1.0.0');

  fs.writeFileSync(file, 'module.exports = { version: "2.0.0", init(plugin) { plugin.store.set("v", 2); } };');
  const result = await bot.plugins.reload('versioned');

  assert.equal(result.ok, true, result.error);
  assert.equal(bot.plugins.get('versioned').version, '2.0.0', 'reload must re-read the file, not the require cache');
});

test('plugins.json disables plugins and supplies config', async (t) => {
  const dir = tempDir('bot-plugins-');

  fs.writeFileSync(path.join(dir, 'skipped.js'), 'plugin.log.info("should never run");');
  fs.writeFileSync(path.join(dir, 'configured.js'), 'plugin.store.set("port", plugin.config.port);');
  fs.writeFileSync(
    path.join(dir, 'plugins.json'),
    JSON.stringify({ disabled: ['skipped'], config: { configured: { port: 8123 } } }),
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.get('skipped').state, 'disabled');
  assert.equal(bot.plugins.get('configured').state, 'loaded');
  assert.equal(bot.plugins.get('configured').context.store.get('port'), 8123);
});

test('discovery skips the files it is meant to skip', async (t) => {
  const dir = tempDir('bot-plugins-');

  fs.writeFileSync(path.join(dir, '_helper.js'), 'throw new Error("underscore files must be skipped");');
  fs.writeFileSync(path.join(dir, '.hidden.js'), 'throw new Error("dotfiles must be skipped");');
  fs.writeFileSync(path.join(dir, 'notes.example.js'), 'throw new Error(".example files must be skipped");');
  fs.writeFileSync(path.join(dir, 'readme.md'), '# not a plugin');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'throw new Error("node_modules must be skipped");');
  fs.writeFileSync(path.join(dir, 'real.js'), 'plugin.store.set("ok", 1);');

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = bot.plugins.list().map((p) => p.name);
  assert.deepEqual(names, ['real'], `discovered ${names.join(', ')}`);
});

test('a directory with index.js loads as a single plugin', async (t) => {
  const dir = tempDir('bot-plugins-');
  const sub = path.join(dir, 'bundle');
  fs.mkdirSync(sub);

  fs.writeFileSync(path.join(sub, 'helper.js'), 'module.exports = { value: 42 };');
  fs.writeFileSync(
    path.join(sub, 'index.js'),
    'const helper = require("./helper"); plugin.store.set("value", helper.value);',
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = bot.plugins.list().map((p) => p.name);
  assert.deepEqual(names, ['bundle'], 'the helper must not load as its own plugin');
  assert.equal(bot.plugins.get('bundle').context.store.get('value'), 42, 'relative require should work');
});

test('a native addon that is not a Node addon gets a useful error', async (t) => {
  const dir = tempDir('bot-plugins-');
  // A plain text file with a native extension: dlopen will refuse it, and the
  // point is that the message explains why rather than leaking a raw dlopen string.
  fs.writeFileSync(path.join(dir, 'fake.node'), 'not actually a shared library');

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plugin = bot.plugins.get('fake');
  assert.equal(plugin.state, 'failed');
  assert.equal(plugin.kind, 'native');
  assert.ok(plugin.error, 'an error should have been recorded');

  const result = await bot.plugins.unload('fake');
  assert.equal(result.ok, false, 'a native addon cannot be unloaded');
});

test('console inside a plugin is routed to the bot logger', async (t) => {
  const dir = tempDir('bot-plugins-');
  fs.writeFileSync(path.join(dir, 'noisy.js'), 'console.log("hello from a plugin"); plugin.store.set("said", true);');

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { buffer } = require('../src/core/logger');
  const line = buffer.items.find((e) => e.msg.includes('hello from a plugin'));
  assert.ok(line, 'the plugin console.log should have reached the log buffer');
  assert.equal(line.scope, 'bot:plugin:noisy', 'and be tagged with the plugin name');
});

test('watching picks up added, edited and deleted files', async (t) => {
  const dir = tempDir('bot-plugins-');
  const port = takePort();
  process.env.PLUGIN_WATCH = 'true';

  const bot = await boot(dir);
  t.after(async () => {
    process.env.PLUGIN_WATCH = 'false';
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.stats().watching, true, 'the watcher should be running');
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  // ---- added ----
  const file = path.join(dir, 'watched.js');
  fs.writeFileSync(file, `require('node:http').createServer().listen(${port}, '127.0.0.1');`);
  await settle();
  assert.equal(bot.plugins.get('watched')?.state, 'loaded', 'a dropped-in file should load itself');
  assert.equal(await portFree(port), false, 'and actually be running');

  // ---- edited ----
  fs.writeFileSync(file, `module.exports = { version: '9.9.9', init() {} };`);
  await settle();
  assert.equal(bot.plugins.get('watched')?.version, '9.9.9', 'an edit should reload it');
  assert.equal(await portFree(port), true, 'and release what the old version held');

  // ---- deleted ----
  fs.writeFileSync(file, `require('node:http').createServer().listen(${port}, '127.0.0.1');`);
  await settle();
  assert.equal(await portFree(port), false, 'reinstated and holding the port again');

  fs.unlinkSync(file);
  await settle();
  assert.equal(bot.plugins.get('watched'), null, 'deleting the file should unload and forget it');
  assert.equal(await portFree(port), true, 'and release the port it held');
});

test('plugins are CommonJS, with a clear error for the usual mistakes', async (t) => {
  const dir = tempDir('bot-plugins-');

  fs.writeFileSync(path.join(dir, 'esm-import.js'), `import fs from 'node:fs';`);
  fs.writeFileSync(path.join(dir, 'esm-export.js'), `export const x = 1;`);
  fs.writeFileSync(path.join(dir, 'tla.js'), `const x = await Promise.resolve(1);`);
  fs.writeFileSync(
    path.join(dir, 'async-init.js'),
    `module.exports = { async init(p) { await Promise.resolve(); p.store.set('ok', 1); } };`,
  );
  fs.writeFileSync(
    path.join(dir, 'portable-import.js'),
    `module.exports = { async init(p) { const os = await p.import('node:os'); p.store.set('platform', os.platform()); } };`,
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ESM syntax cannot work in a CommonJS wrapper, but the error must say so
  // and name the fix rather than repeating V8's wording.
  assert.equal(bot.plugins.get('esm-import').state, 'failed');
  assert.match(bot.plugins.get('esm-import').error.message, /CommonJS/);
  assert.match(bot.plugins.get('esm-import').error.message, /require\(/);

  assert.equal(bot.plugins.get('esm-export').state, 'failed');
  assert.match(bot.plugins.get('esm-export').error.message, /module\.exports/);

  assert.equal(bot.plugins.get('tla').state, 'failed');
  assert.match(bot.plugins.get('tla').error.message, /async init/);

  // The supported paths.
  assert.equal(bot.plugins.get('async-init').state, 'loaded', 'an async init() must work');
  assert.equal(bot.plugins.get('portable-import').state, 'loaded', 'plugin.import() must work');
  assert.ok(bot.plugins.get('portable-import').context.store.get('platform'), 'and actually return the module');
});

test('the bundled example plugins load and behave', async (t) => {
  // Runs against the real plugins/ directory, so a broken shipped example is
  // caught rather than shipped.
  const port = takePort();
  const dir = tempDir('bot-plugins-');
  fs.copyFileSync(path.join(ROOT, 'plugins', 'httpserver.js'), path.join(dir, 'httpserver.js'));
  fs.copyFileSync(path.join(ROOT, 'plugins', 'hello.js'), path.join(dir, 'hello.js'));
  fs.writeFileSync(
    path.join(dir, 'plugins.json'),
    JSON.stringify({ disabled: [], config: { httpserver: { port, host: '127.0.0.1' } } }),
  );

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(bot.plugins.get('httpserver').state, 'loaded');
  assert.equal(bot.plugins.get('hello').state, 'loaded');
  assert.ok(bot.registry.has('hello'), 'the example should register /hello');

  await new Promise((r) => setTimeout(r, 300));
  const status = await get(`http://127.0.0.1:${port}/status`);
  assert.equal(status.status, 200);

  const json = JSON.parse(status.body);
  assert.equal(json.ok, true);
  assert.equal(json.mode, 'plugin');
  assert.equal(typeof json.commands, 'number');

  const metrics = await get(`http://127.0.0.1:${port}/metrics`);
  assert.match(metrics.body, /discordbot_guilds \d+/);

  const notFound = await get(`http://127.0.0.1:${port}/nope`);
  assert.equal(notFound.status, 404);
});
