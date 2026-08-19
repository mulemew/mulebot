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

test('directory plugins honour package.json main and metadata', async (t) => {
  const dir = tempDir('bot-plugins-');

  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'package.json'),
    JSON.stringify({ name: 'bundle', version: '4.5.6', description: 'from manifest', main: 'src/app.js' }),
  );
  fs.writeFileSync(path.join(bundle, 'src', 'app.js'), `plugin.store.set('entry', 'src/app.js');`);

  // main pointing outside the plugin folder must be ignored, not followed.
  const escapee = path.join(dir, 'escapee');
  fs.mkdirSync(escapee, { recursive: true });
  fs.writeFileSync(path.join(escapee, 'package.json'), JSON.stringify({ main: '../../../src/bot.js' }));
  fs.writeFileSync(path.join(escapee, 'index.js'), `plugin.store.set('safe', true);`);

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const p = bot.plugins.get('bundle');
  assert.equal(p.state, 'loaded');
  assert.equal(p.version, '4.5.6', 'version should come from package.json');
  assert.equal(p.description, 'from manifest');
  assert.equal(p.context.store.get('entry'), 'src/app.js', 'main should decide the entry point');

  const e = bot.plugins.get('escapee');
  assert.equal(e.state, 'loaded');
  assert.equal(e.context.store.get('safe'), true, 'a main escaping the folder must fall back to index.js');
});

test('archives are read and extracted safely', () => {
  const archive = require('../src/core/archive');
  const zlib = require('node:zlib');

  // Build a real tar.gz rather than checking in a binary fixture.
  const tar = (files) => {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.from(content, 'utf8');
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write('0000644\0', 100, 8, 'ascii');
      h.write('0000000\0', 108, 8, 'ascii');
      h.write('0000000\0', 116, 8, 'ascii');
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      h.write('00000000000\0', 136, 12, 'ascii');
      h.write('        ', 148, 8, 'ascii');
      h.write('0', 156, 1, 'ascii');
      h.write('ustar\0', 257, 6, 'ascii');
      h.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  };

  const good = tar({ 'wrapper/index.js': 'module.exports = {};', 'wrapper/lib/a.js': 'x' });
  assert.equal(archive.read(good).length, 2);

  const out = tempDir('bot-extract-');
  const result = archive.extract(good, out);
  assert.equal(result.stripped, 'wrapper', 'a single top-level directory should be stripped');
  assert.ok(fs.existsSync(path.join(out, 'index.js')));
  assert.ok(fs.existsSync(path.join(out, 'lib', 'a.js')));

  // Zip slip: an entry that climbs out of the destination must never be written.
  // A mixed archive proves the good entry still lands while the escape does not.
  const mixed = tar({ 'ok.js': 'fine', '../../escaped.js': 'owned', '/abs.js': 'owned' });
  const target = tempDir('bot-extract-');
  archive.extract(mixed, target);

  assert.ok(fs.existsSync(path.join(target, 'ok.js')), 'the legitimate entry should extract');
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'escaped.js')), false, 'traversal must be blocked');
  assert.equal(fs.existsSync(path.join(target, 'abs.js')), false, 'absolute paths must be blocked');

  // An archive containing nothing but escapes leaves nothing to extract, which
  // surfaces as an error rather than a silent success.
  assert.throws(() => archive.extract(tar({ '../../only-evil.js': 'x' }), target), /no files/);
  assert.equal(archive.safeEntryPath('../x'), null);
  assert.equal(archive.safeEntryPath('/etc/passwd'), null);
  assert.equal(archive.safeEntryPath('C:\\windows\\x'), null);
  assert.equal(archive.safeEntryPath('lib/ok.js'), 'lib/ok.js');

  assert.throws(() => archive.read(Buffer.from('not an archive at all')), /unrecognised/);

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('installing from a URL supports disk, once and memory modes', async (t) => {
  const dir = tempDir('bot-plugins-');
  const port = takePort();

  const origin = http.createServer((req, res) => {
    if (req.url === '/p.js') {
      res.writeHead(200);
      res.end("plugin.store.set('loaded', true);");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => origin.listen(port, '127.0.0.1', r));

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    origin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}/p.js`;

  const kept = await bot.plugins.installFromUrl(url, { mode: 'persist', name: 'kept' });
  assert.equal(kept.ok, true, kept.error);
  assert.ok(fs.existsSync(path.join(dir, 'kept.js')), 'persist mode writes the file');

  const once = await bot.plugins.installFromUrl(url, { mode: 'once', name: 'once' });
  assert.equal(once.ok, true, once.error);
  assert.equal(fs.existsSync(path.join(dir, 'once.js')), false, 'once mode deletes the file');
  assert.equal(bot.plugins.get('once').state, 'loaded', 'but keeps running in this process');

  const mem = await bot.plugins.installFromUrl(url, { mode: 'memory', name: 'mem' });
  assert.equal(mem.ok, true, mem.error);
  assert.equal(fs.existsSync(path.join(dir, 'mem.js')), false, 'memory mode never touches the disk');
  assert.equal(bot.plugins.get('mem').ephemeral, true);
  assert.equal(bot.plugins.get('mem').context.store.get('loaded'), true, 'and actually runs');

  // Only memory-mode plugins are remembered for refetching; "once" is meant to
  // disappear on restart and must not be recorded.
  const remotes = bot.plugins.readRemotes();
  assert.ok(remotes.mem, 'memory mode is remembered');
  assert.equal(remotes.once, undefined, 'once mode is not remembered');

  await assert.rejects(() => bot.plugins.installFromUrl('file:///etc/passwd', { name: 'x' }), /http/);
  await assert.rejects(() => bot.plugins.installFromUrl('nonsense', { name: 'x' }), /valid URL/);
});

test('a fresh install opens no port and adds no command', async (t) => {
  // The bundled plugins are examples and ship disabled. Without that, cloning
  // this repo and starting it would take port 3000 — which a Discord bot has no
  // reason to do, and which collides with most dev servers — and would add a
  // /hello command to every server the bot is in.
  const bot = await boot(path.join(ROOT, 'plugins'));
  t.after(async () => {
    await bot.shutdown();
  });
  await new Promise((r) => setTimeout(r, 400));

  const listening = (process._getActiveHandles?.() || []).filter((h) => h.constructor?.name === 'Server');
  assert.equal(listening.length, 0, `a fresh install opened ${listening.length} port(s)`);

  const fromPlugins = bot.registry.all().filter((c) => String(c.file).startsWith('plugin:'));
  assert.deepEqual(fromPlugins, [], 'a fresh install registered a command from a plugin');

  const stats = bot.plugins.stats();
  assert.equal(stats.loaded, 0, 'no example should be loaded by default');
  assert.ok(stats.disabled >= 2, 'both examples should be listed as disabled, not missing');
});

test('httpserver adopts the port a platform injects', async (t) => {
  // A PaaS routes traffic and health checks to the port it injected, so the
  // status endpoint has to bind that one, on all interfaces rather than
  // localhost, or the deployment is marked unhealthy and killed.
  const dir = tempDir('bot-plugins-');
  const injected = takePort();

  fs.copyFileSync(path.join(ROOT, 'plugins', 'httpserver.js'), path.join(dir, 'httpserver.js'));

  process.env.PORT = String(injected);
  const bot = await boot(dir);
  t.after(async () => {
    delete process.env.PORT;
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 400));

  const owned = bot.plugins.get('httpserver')?.context?.owned?.resources || [];
  const server = owned.find((r) => typeof r.resource?.address === 'function' && r.resource.address());
  assert.ok(server, 'the status endpoint should be listening');

  const address = server.resource.address();
  assert.equal(address.port, injected, 'it must adopt the injected port');
  assert.equal(address.address, '0.0.0.0', 'and bind all interfaces so the health check can reach it');
});

test('archives support once mode, and refuse memory mode with a way forward', async (t) => {
  // A bundle needs a real directory: relative require() resolves against it, and
  // files like an index.html are read from it by path. So memory mode is refused
  // — but "once" extracts, loads, then deletes, which leaves nothing on disk and
  // is what people usually mean. It used to fall through to "persist" silently,
  // so asking for a throwaway install quietly produced a permanent one.
  const zlib = require('node:zlib');
  const dir = tempDir('bot-plugins-');
  const port = takePort();

  const tar = (files) => {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.from(content, 'utf8');
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write('0000644\0', 100, 8, 'ascii');
      h.write('0000000\0', 108, 8, 'ascii');
      h.write('0000000\0', 116, 8, 'ascii');
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      h.write('00000000000\0', 136, 12, 'ascii');
      h.write('        ', 148, 8, 'ascii');
      h.write('0', 156, 1, 'ascii');
      h.write('ustar\0', 257, 6, 'ascii');
      h.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  };

  // The shape people actually ship: a manifest, an entry point, and an asset
  // the entry point reads from its own directory.
  const bundle = tar({
    'pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }),
    'pkg/index.js':
      "const fs = require('node:fs'), path = require('node:path');" +
      "plugin.store.set('html', fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8').length);",
    'pkg/page.html': '<h1>hello</h1>',
  });

  const origin = http.createServer((req, res) => {
    if (req.url === '/b.tgz') {
      res.writeHead(200);
      res.end(bundle);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => origin.listen(port, '127.0.0.1', r));

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    origin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${port}/b.tgz`;

  await assert.rejects(
    () => bot.plugins.installFromUrl(url, { mode: 'memory', name: 'mem' }),
    /cannot run purely from memory/,
    'an archive must not pretend to run from memory',
  );

  const once = await bot.plugins.installFromUrl(url, { mode: 'once', name: 'once' });
  assert.equal(once.ok, true, once.error);
  assert.equal(once.mode, 'once', 'it must report once, not silently persist');
  assert.equal(fs.existsSync(path.join(dir, 'once')), false, 'the directory must be deleted after loading');
  assert.equal(bot.plugins.get('once').state, 'loaded', 'but the plugin keeps running');
  assert.equal(bot.plugins.get('once').ephemeral, true);
  assert.equal(bot.plugins.readRemotes().once, undefined, 'once must not be remembered for refetching');

  // A file read during load is already in memory and survives the deletion.
  assert.equal(bot.plugins.get('once').context.store.get('html'), 14, 'the bundled asset was read at load time');
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

// ---------------------------------------------------------------------------
// npm's cache directory
// ---------------------------------------------------------------------------

test('npm is given a writable cache instead of inheriting a broken HOME', () => {
  const { PluginHost } = require('../src/core/plugins');
  const dataDir = tempDir('npmenv-d-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const host = new PluginHost({ config: { dataDir, rootDir: dataDir, pluginsDir: dataDir } }, { dir: dataDir, log });

  const before = process.env.HOME;
  try {
    // A container running as a non-root user with no home directory: npm
    // derives its cache from HOME and dies on mkdir before it fetches anything.
    process.env.HOME = path.join(dataDir, 'does', 'not', 'exist');
    const env = host.npmEnv();

    assert.equal(env.npm_config_cache, path.join(dataDir, '.npm'), 'the cache goes beside the data, which is known writable');
    assert.notEqual(env.HOME, process.env.HOME, 'a HOME that does not exist is not passed through');
    assert.ok(fs.existsSync(env.HOME), 'whatever HOME is set to must actually exist');
    assert.equal(env.npm_config_update_notifier, 'false');
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

test('packages go somewhere writable when the project directory is not', () => {
  const { PluginHost } = require('../src/core/plugins');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const make = (config) => new PluginHost({ config, log }, { dir: config.pluginsDir, log });

  const writableRoot = tempDir('mod-root-');
  const dataDir = tempDir('mod-data-');

  // Normal case: everything beside discord.js, one node_modules.
  const plain = make({ rootDir: writableRoot, dataDir, pluginsDir: writableRoot });
  assert.equal(plain.modulesDir.dir, writableRoot);
  assert.equal(plain.modulesDir.temporary, false);

  // A read-only project, which is how plenty of containers are mounted. Using
  // a path under a regular file makes mkdir fail the same way, on any platform.
  const blocker = path.join(tempDir('mod-block-'), 'file');
  fs.writeFileSync(blocker, 'not a directory');
  const readOnly = make({ rootDir: path.join(blocker, 'app'), dataDir, pluginsDir: dataDir });
  assert.equal(readOnly.modulesDir.dir, path.join(dataDir, 'npm'), 'falls back to the data directory');
  assert.equal(readOnly.modulesDir.temporary, false, 'the data directory persists, so this is not temporary');

  // An explicit override wins over both.
  const chosen = tempDir('mod-explicit-');
  process.env.PLUGIN_MODULES_DIR = chosen;
  try {
    const overridden = make({ rootDir: writableRoot, dataDir, pluginsDir: writableRoot });
    assert.equal(overridden.modulesDir.dir, chosen);
  } finally {
    delete process.env.PLUGIN_MODULES_DIR;
  }

  // npm must not adopt a parent's package.json and rewrite the bot's deps.
  const prefix = tempDir('mod-prefix-');
  readOnly.ensureNpmPrefix(prefix);
  const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
});

test('plugin switches are settable from the environment, not only the file', async () => {
  const { PluginHost } = require('../src/core/plugins');
  const dir = tempDir('penv-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ disabled: ['fromfile'], config: {} }));

  const read = () => {
    const host = new PluginHost({ config: { rootDir: dir, dataDir: dir, pluginsDir: dir } }, { dir, log });
    host.readManifest();
    return host.manifest.disabled;
  };

  const saved = [process.env.PLUGINS_DISABLED, process.env.PLUGINS_ALLOW];
  try {
    delete process.env.PLUGINS_DISABLED;
    delete process.env.PLUGINS_ALLOW;
    assert.deepEqual(read(), ['fromfile'], 'the file still decides when nothing is set');

    process.env.PLUGINS_DISABLED = 'one, two';
    assert.deepEqual(read(), ['fromfile', 'one', 'two'], 'the environment adds to the file, spaces trimmed');

    // The point of this: a container where plugins.json cannot be edited.
    process.env.PLUGINS_ALLOW = 'fromfile';
    assert.deepEqual(read(), ['one', 'two'], 'and can re-enable what the file disabled');

    process.env.PLUGINS_DISABLED = 'both';
    process.env.PLUGINS_ALLOW = 'both';
    assert.deepEqual(read(), ['fromfile'], 'naming one in both means load it: the explicit yes wins');
  } finally {
    for (const [k, v] of [['PLUGINS_DISABLED', saved[0]], ['PLUGINS_ALLOW', saved[1]]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('plugin URLs can be configured, so a host with no disk still gets them', async () => {
  const http = require('node:http');
  const { PluginHost } = require('../src/core/plugins');

  // A tiny origin serving one plugin.
  const served = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('plugin.log.info("from a url");\n');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${served.address().port}/fromurl.js`;

  const dir = tempDir('purl-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const bot = { config: { rootDir: dir, dataDir: dir, pluginsDir: dir, saveIntervalMs: 1000 }, log };

  const saved = process.env.PLUGINS_URLS;
  try {
    process.env.PLUGINS_URLS = url;
    const host = new PluginHost(bot, { dir, log });
    host.readManifest();
    assert.deepEqual(host.manifest.urls, [url], 'the environment supplies the list');

    const result = await host.restoreRemotes();
    assert.equal(result.restored, 1, 'and it is fetched at boot with nothing remembered on disk');
    assert.equal(result.failed, 0);
    assert.ok(host.plugins.has('fromurl'), 'the plugin is loaded under a name derived from the URL');

    // The point of the feature: nothing was written, so a restart repeats this.
    assert.equal(fs.existsSync(path.join(dir, 'fromurl.js')), false, 'memory mode leaves no file behind');
  } finally {
    if (saved === undefined) delete process.env.PLUGINS_URLS;
    else process.env.PLUGINS_URLS = saved;
    served.close();
  }
});

test('a tracked child process is killed on unload, not left running', async () => {
  const { PluginHost } = require('../src/core/plugins');
  const dir = tempDir('cproc-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const bot = {
    config: { rootDir: dir, dataDir: dir, pluginsDir: dir, saveIntervalMs: 1000 },
    log,
    registry: { remove() {} },
    components: { unregister() {} },
    scheduler: { unregister() {} },
    client: { on() {}, once() {}, removeListener() {} },
  };

  const file = path.join(dir, 'spawner.js');
  fs.writeFileSync(
    file,
    "const { spawn } = require('node:child_process');\n" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(function(){},1e9)']);\n" +
      'plugin.track(c);\n' +
      'globalThis.__childPid = c.pid;\n',
  );

  const host = new PluginHost(bot, { dir, log });
  await host.loadAll();

  const pid = globalThis.__childPid;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(pid && alive(), 'the child is running to begin with');

  const result = await host.unload('spawner');

  // kill() takes a signal, so handing it the completion callback used to throw
  // "Unknown signal" and leave the process behind - once per reload.
  assert.deepEqual(result.problems, [], 'closing reports no problem');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(alive(), false, 'the child is gone');

  delete globalThis.__childPid;
});
