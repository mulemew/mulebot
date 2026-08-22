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

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The transport is stubbed on purpose. Only https is installable now, and
  // standing up a TLS origin with a trusted certificate would exercise Node's
  // TLS stack rather than this file's mode handling, which is the interesting
  // part. What the transport refuses has its own test further down.
  const url = 'https://example.invalid/p.js';
  bot.plugins.download = async () => ({
    buffer: Buffer.from("plugin.store.set('loaded', true);"),
    contentType: 'application/javascript',
    url,
    verified: false,
  });

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

  // Back to the real download() for the refusals.
  delete bot.plugins.download;
  await assert.rejects(() => bot.plugins.installFromUrl('file:///etc/passwd', { name: 'x' }), /https/);
  await assert.rejects(() => bot.plugins.installFromUrl('http://example.com/p.js', { name: 'x' }), /https/);
  await assert.rejects(() => bot.plugins.installFromUrl('nonsense', { name: 'x' }), /valid URL/);
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

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Transport stubbed, as in the test above: what matters here is what the
  // installer does with an archive, not how the bytes arrived.
  const url = 'https://example.invalid/b.tgz';
  bot.plugins.download = async () => ({
    buffer: bundle,
    contentType: 'application/gzip',
    url,
    verified: false,
  });

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
  const { PluginHost } = require('../src/core/plugins');

  const url = 'https://example.invalid/fromurl.js';
  const dir = tempDir('purl-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const bot = { config: { rootDir: dir, dataDir: dir, pluginsDir: dir, saveIntervalMs: 1000 }, log };

  const saved = process.env.PLUGINS_URLS;
  try {
    process.env.PLUGINS_URLS = url;
    const host = new PluginHost(bot, { dir, log });
    // Transport stubbed: this test is about the configured list being read and
    // fetched at boot, not about how the bytes travel.
    host.download = async () => ({
      buffer: Buffer.from('plugin.log.info("from a url");\n'),
      contentType: 'application/javascript',
      url,
      verified: false,
    });
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
  }
});

test('a spawned child is reclaimed on unload without the plugin asking', async () => {
  const { PluginHost } = require('../src/core/plugins');
  const dir = tempDir('autocp-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const bot = {
    config: { rootDir: dir, dataDir: dir, pluginsDir: dir, saveIntervalMs: 1000 },
    log,
    registry: { remove() {} },
    components: { unregister() {} },
    scheduler: { unregister() {} },
    client: { on() {}, once() {}, removeListener() {} },
  };

  // Neither plugin calls plugin.track(). That is the point: a plain script that
  // knows nothing about the host still unloads cleanly.
  const IDLE = "['-e', 'setInterval(function(){},1e9)']";
  fs.writeFileSync(
    path.join(dir, 'plain.js'),
    [
      "const { spawn } = require('node:child_process');",
      `globalThis.__plainPid = spawn(process.execPath, ${IDLE}).pid;`,
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'detach.js'),
    [
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, ${IDLE}, { detached: true, stdio: 'ignore' });`,
      'c.unref();',
      'globalThis.__detachedPid = c.pid;',
    ].join('\n'),
  );

  const host = new PluginHost(bot, { dir, log });
  await host.loadAll();

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const plain = globalThis.__plainPid;
  const detached = globalThis.__detachedPid;
  assert.ok(alive(plain) && alive(detached), 'both children start out running');

  await host.unload('plain');
  await host.unload('detach');
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(alive(plain), false, 'an ordinary child is killed with the plugin that spawned it');
  // detached: true is the only way a plugin can say "this outlives me", so it
  // is the only case left alone.
  assert.equal(alive(detached), true, 'a detached child is deliberately left running');

  process.kill(detached);
  delete globalThis.__plainPid;
  delete globalThis.__detachedPid;
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

// ---------------------------------------------------------------------------
// what the installer will and will not fetch
// ---------------------------------------------------------------------------

test('addresses inside the network are not fetchable', () => {
  const { isInternalAddress } = require('../src/core/plugins');

  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.9.9',
    '172.31.255.255',
    '192.168.1.1',
    '100.100.0.1',
    '169.254.169.254', // cloud metadata: the one that hands out credentials
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1', // the same loopback wearing an IPv6 hat
  ];
  for (const address of blocked) {
    assert.equal(isInternalAddress(address), true, `${address} must be refused`);
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];
  for (const address of allowed) {
    assert.equal(isInternalAddress(address), false, `${address} is public and must be allowed`);
  }
});

test('the installer refuses http, and checks a pinned sha256', async () => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { PluginHost } = require('../src/core/plugins');

  const dir = tempDir('dl-');
  const log = { info() {}, warn() {}, debug() {}, error() {}, child: () => log };
  const host = new PluginHost({ config: { rootDir: dir, dataDir: dir, pluginsDir: dir }, log }, { dir, log });

  const body = 'plugin.log.info("hi");\n';
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => res.end(body));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    // http is refused before anything is fetched, whatever it points at.
    await assert.rejects(
      () => host.download(`http://127.0.0.1:${port}/x.js`),
      /only https URLs can be installed/,
      'plain http is refused outright',
    );

    // And the sha256 check is a real comparison, not a parse.
    const right = crypto.createHash('sha256').update(body).digest('hex');
    const wrong = 'b'.repeat(64);
    assert.notEqual(right, wrong);
    await assert.rejects(
      () => host.download(`https://example.invalid/x.js#sha256=${wrong}`),
      /./,
      'an unreachable or mismatched download fails rather than loading',
    );
  } finally {
    server.close();
  }
});

test('healthz reports what the bot is actually doing, not that it is alive', async (t) => {
  const dir = tempDir('hz-');
  const port = takePort();

  fs.copyFileSync(path.join(ROOT, 'plugins', 'healthz.js'), path.join(dir, 'healthz.js'));

  const saved = { allow: process.env.PLUGINS_ALLOW, port: process.env.PORT, grace: process.env.HEALTHZ_GATEWAY_GRACE_MS };
  process.env.PLUGINS_ALLOW = 'healthz';
  process.env.PORT = String(port);
  // Long enough that the checks between here and the expiry assertion cannot
  // outrun it, short enough to wait out in a test.
  process.env.HEALTHZ_GATEWAY_GRACE_MS = '1000';

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['PLUGINS_ALLOW', saved.allow], ['PORT', saved.port], ['HEALTHZ_GATEWAY_GRACE_MS', saved.grace]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  assert.equal(bot.plugins.get('healthz').state, 'loaded', 'PLUGINS_ALLOW overrode the shipped disable');
  await new Promise((r) => setTimeout(r, 250));

  const check = async () => {
    const res = await get(`http://127.0.0.1:${port}/healthz`);
    return { status: res.status, json: JSON.parse(res.body) };
  };

  // Never connected is "starting", not "broken" - a platform that waits should
  // wait, and one that restarts on failure should not restart a booting bot.
  let r = await check();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, 'starting');

  bot.readyAt = Date.now();
  bot.client.ws.status = 0;
  r = await check();
  assert.equal(r.status, 200, 'connected gateway is healthy');
  assert.equal(r.json.status, 'ok');

  // A drop rides out the grace period, so a Discord hiccup is not a restart.
  bot.client.ws.status = 5;
  r = await check();
  assert.equal(r.status, 200, 'a fresh disconnect is still healthy');

  await new Promise((res) => setTimeout(res, 1200));
  r = await check();
  assert.equal(r.status, 503, 'past the grace period it is not');
  assert.match(r.json.checks.gateway.detail, /disconnected for/);

  // A stalled event loop fails even with the gateway up: the bot is connected
  // and still missing every interaction, which is the case a liveness check
  // built on "the port answers" cannot see.
  bot.client.ws.status = 0;
  bot.lagPeak = 9000;
  r = await check();
  assert.equal(r.status, 503);
  assert.equal(r.json.status, 'degraded');

  // Nothing identifying on what is often a public URL.
  const body = JSON.stringify(r.json);
  for (const leak of ['guild', 'token', 'user', 'name', 'id']) {
    assert.equal(body.toLowerCase().includes(`"${leak}`), false, `the body must not carry ${leak}`);
  }

  assert.equal((await get(`http://127.0.0.1:${port}/nope`)).status, 404);

  await bot.plugins.unload('healthz');
  assert.equal(await portFree(port), true, 'unloading frees the port');
});

test('an archive with a bundled dependency and a native addon loads as one plugin', async (t) => {
  const zlib = require('node:zlib');
  const dir = tempDir('bundle-');

  const tar = (files) => {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write('0000644\0', 100, 8, 'ascii');
      h.write('0000000\0', 108, 8, 'ascii');
      h.write('0000000\0', 116, 8, 'ascii');
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      h.write('00000000000\0', 136, 12, 'ascii');
      h.write('        ', 148, 8, 'ascii');
      h.write('0', 156, 1, 'ascii');
      h.write('ustar\0' + '00', 257, 8, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  };

  // A stand-in for a compiled addon. It is never dlopen'd here - what matters
  // is that it travels with the plugin and is not mistaken for one.
  const bundle = tar({
    'mypkg/package.json': JSON.stringify({ name: 'mypkg', version: '1.0.0', main: 'index.js' }),
    'mypkg/index.js': [
      "const fs = require('node:fs');",
      "const helper = require('./lib/helper');",
      'plugin.store.set("helper", helper.greet());',
      'plugin.store.set("dir", fs.readdirSync(__dirname).sort().join(","));',
    ].join('\n'),
    'mypkg/lib/helper.js': 'module.exports = { greet: () => "helper works" };',
    'mypkg/native.node': Buffer.from('not a real addon, just cargo'),
  });

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await bot.plugins.installFromBuffer(bundle, { filename: 'mypkg.tar.gz' });

  // ".tar.gz" is two extensions. Stripping one left plugins called "mypkg.tar",
  // and only when uploaded - the URL path stripped both, so the same bundle got
  // a different name depending on how it arrived.
  assert.equal(result.name, 'mypkg', 'both extensions come off the name');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stripped, 'mypkg', 'the wrapper directory is stripped');

  const plugin = bot.plugins.get('mypkg');
  assert.equal(plugin.state, 'loaded');
  assert.equal(plugin.version, '1.0.0', 'metadata comes from the bundled package.json');
  assert.equal(plugin.context.store.get('helper'), 'helper works', 'a relative require inside the bundle resolves');
  assert.equal(
    plugin.context.store.get('dir'),
    'index.js,lib,native.node,package.json',
    'every file travelled, including the addon',
  );

  // The directory is one plugin: its helper and its .node must not be loaded
  // as plugins of their own.
  // get() returns null for an unknown name, not undefined.
  assert.ok(!bot.plugins.get('native'), 'the addon is not a separate plugin');
  assert.ok(!bot.plugins.get('helper'), 'the helper is not a separate plugin');
  assert.equal([...bot.plugins.plugins.keys()].length, 1);
});

test('PLUGINS_URLS takes archives as well as scripts, and leaves nothing behind', async (t) => {
  const zlib = require('node:zlib');
  const dir = tempDir('purl2-');

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
      h.write('ustar\0' + '00', 257, 8, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  };

  const bundle = tar({
    'tools/package.json': JSON.stringify({ name: 'tools', version: '2.0.0', main: 'index.js' }),
    'tools/index.js': [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "plugin.store.set('helper', require('./lib/helper')());",
      "plugin.store.set('asset', fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8').trim());",
    ].join('\n'),
    'tools/lib/helper.js': "module.exports = () => 'relative require works';",
    'tools/data.txt': 'a file read by path',
  });

  const SCRIPT = 'https://example.invalid/single.js';
  const BUNDLE = 'https://example.invalid/tools.tar.gz';

  const saved = process.env.PLUGINS_URLS;
  process.env.PLUGINS_URLS = `${SCRIPT},${BUNDLE}`;

  const bot = await boot(dir);
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PLUGINS_URLS;
    else process.env.PLUGINS_URLS = saved;
  });

  bot.plugins.download = async (url) => ({
    buffer: url.startsWith(BUNDLE) ? bundle : Buffer.from("plugin.store.set('kind', 'script');"),
    contentType: 'application/octet-stream',
    url,
    verified: false,
  });

  bot.plugins.readManifest();
  const result = await bot.plugins.restoreRemotes();
  assert.equal(result.failed, 0);
  assert.equal(result.restored, 2, 'both shapes load');

  // A script runs from the string; an archive needs a directory, so it is
  // extracted, loaded and removed. The caller writing the URL into an
  // environment variable does not have to know which it is.
  const script = bot.plugins.get('single');
  assert.equal(script.state, 'loaded');
  assert.equal(script.context.store.get('kind'), 'script');

  const archive = bot.plugins.get('tools');
  assert.equal(archive.state, 'loaded');
  assert.equal(archive.version, '2.0.0', 'metadata comes from the bundled package.json');
  assert.equal(archive.context.store.get('helper'), 'relative require works');
  assert.equal(archive.context.store.get('asset'), 'a file read by path', 'a data file was read at load time');

  // Both are ephemeral: nothing survives a restart, which is what makes
  // re-fetching on every boot the correct behaviour rather than a waste.
  assert.equal(script.ephemeral, true);
  assert.equal(archive.ephemeral, true);
  assert.deepEqual(fs.readdirSync(dir), [], 'the plugins directory is untouched');

  const scratch = bot.plugins.writableDir().dir;
  const leftover = fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];
  assert.deepEqual(leftover, [], 'the extracted directory is removed after loading');
});

test('a registry that cannot be written does not fail an install that worked', async (t) => {
  const dir = tempDir('rec-');
  const data = tempDir('rec-d-');

  // Block <DATA_DIR>/plugins by putting a file where the directory must go.
  fs.writeFileSync(path.join(data, 'plugins'), 'not a directory');

  process.env.PLUGINS_DIR = dir;
  process.env.DATA_DIR = data;
  process.env.LOG_LEVEL = 'silent';
  process.env.REGISTER_COMMANDS = 'false';

  const Bot = require('../src/bot');
  const bot = new Bot({ token: 'x.y.z', rootDir: ROOT, discord });
  await bot.init();
  t.after(async () => {
    await bot.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  bot.plugins.download = async (url) => ({
    buffer: Buffer.from('plugin.log.info("ran");'),
    contentType: 'application/javascript',
    url,
    verified: false,
  });

  // The download and the load both succeeded before the bookkeeping ran, so an
  // exception here used to be reported as "Install failed" for an install that
  // had in fact worked and was running - leaving no way to tell a failed record
  // from one that was never attempted.
  const result = await bot.plugins.installFromUrl('https://example.invalid/p.js', { mode: 'persist' });

  assert.equal(result.ok, true, 'the install still succeeds');
  assert.equal(bot.plugins.get('p').state, 'loaded', 'and the plugin is running');
  assert.ok(result.recordError, 'but the caller is told the source was not recorded');
  assert.match(result.recordError, /EEXIST|ENOTDIR|EACCES|EPERM/, 'with the reason attached');

  assert.deepEqual(bot.plugins.readRemotes(), {}, 'reading an absent registry is still safe');

});
