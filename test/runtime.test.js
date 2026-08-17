'use strict';

/**
 * Runtime resource-management tests: cache profiles, log rotation and the
 * housekeeping pass.
 *
 * These cover the things that only bite after the bot has been running for a
 * long time on a small host, which is exactly when nobody is watching.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const discord = require('discord.js');
const cache = require('../src/core/cache');
const { RotatingFile } = require('../src/core/logger');
const { Database, isEmptyMember, DEFAULT_MEMBER } = require('../src/core/db');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------------
test('every cache profile builds options a real Client accepts', () => {
  // The regression this guards: only messages, threads and invites accept a
  // `lifetime`. Every other sweeper needs a filter function, and discord.js
  // throws at construction - so a bad profile is a boot crash, not a warning.
  for (const name of ['low', 'balanced', 'high']) {
    const built = cache.build(discord, name);
    assert.equal(built.profile, name);
    assert.ok(built.options.makeCache, `${name} produced no makeCache`);
    assert.ok(built.options.sweepers, `${name} produced no sweepers`);

    const client = new discord.Client({
      intents: [discord.GatewayIntentBits.Guilds],
      ...built.options,
    });
    assert.ok(client.options.sweepers, `${name} did not survive Client construction`);
    client.destroy();
  }
});

test('cache profiles never limit the managers discord.js needs intact', () => {
  for (const name of ['low', 'balanced', 'high']) {
    const profile = cache.PROFILES[name];
    for (const manager of ['GuildManager', 'ChannelManager', 'GuildChannelManager', 'RoleManager']) {
      assert.equal(
        profile.cache[manager],
        undefined,
        `${name} must not limit ${manager} — discord.js relies on it being complete`,
      );
    }
  }
});

test('the low profile is meaningfully tighter than the high one', () => {
  const low = cache.PROFILES.low;
  const high = cache.PROFILES.high;

  assert.ok(low.cache.MessageManager < high.cache.MessageManager, 'low must cache fewer messages');
  assert.ok(Object.keys(low.sweep).length > Object.keys(high.sweep).length, 'low must sweep more aggressively');
  assert.ok(low.maintenanceHours <= high.maintenanceHours, 'low must run housekeeping at least as often');
  assert.ok(low.tradeoffs.length > 0, 'an aggressive profile must document what it costs');
});

test('profile auto-detection picks by available memory', () => {
  // detectProfile reads the cgroup limit first so a small container on a large
  // host does not pick a profile that will get it OOM-killed.
  const detected = cache.detectProfile();
  assert.ok(['low', 'balanced', 'high'].includes(detected));

  const limit = cache.containerMemoryLimitMb();
  assert.ok(limit === null || (Number.isFinite(limit) && limit > 0), 'a cgroup limit must be null or a real number');
});

// ---------------------------------------------------------------------------
test('log rotation puts a hard ceiling on disk usage', () => {
  const dir = tempDir('bot-logs-');
  const file = path.join(dir, 'bot.log');

  const sink = new RotatingFile({ file, maxBytes: 2000, keep: 3 });
  const line = `${'x'.repeat(200)}\n`;
  for (let i = 0; i < 500; i++) sink.write(line);
  sink.close();

  const files = fs.readdirSync(dir);
  assert.ok(files.length <= 4, `expected at most 4 generations, found ${files.length}: ${files.join(', ')}`);

  const total = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  // 500 × 200 bytes is 100kb of input; the cap is maxBytes × (keep + 1) = 8kb.
  assert.ok(total <= 2000 * 5, `total log size ${total} exceeded the ceiling`);
  assert.ok(fs.existsSync(file), 'the live log file must still exist');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('log rotation survives an unwritable path without throwing', () => {
  // A full disk or a bad path must never take the bot down.
  const sink = new RotatingFile({ file: path.join(os.tmpdir(), 'no-such-dir\0bad', 'x.log'), maxBytes: 100, keep: 1 });
  assert.doesNotThrow(() => sink.write('hello\n'));
  assert.equal(sink.failed, true, 'it should mark itself failed rather than throwing');
  sink.close();
});

// ---------------------------------------------------------------------------
test('isEmptyMember distinguishes a real record from a lookup artefact', () => {
  // Records are created on read, so /balance @someone leaves a row behind.
  assert.equal(isEmptyMember(structuredClone(DEFAULT_MEMBER)), true, 'a fresh default record holds nothing');
  assert.equal(isEmptyMember({}), true);
  assert.equal(isEmptyMember(null), true);

  const withXp = { ...structuredClone(DEFAULT_MEMBER), xp: 5 };
  assert.equal(isEmptyMember(withXp), false);

  const withCoins = { ...structuredClone(DEFAULT_MEMBER), coins: 1 };
  assert.equal(isEmptyMember(withCoins), false);

  const withItems = { ...structuredClone(DEFAULT_MEMBER), inventory: { fish: 1 } };
  assert.equal(isEmptyMember(withItems), false);

  const withBio = { ...structuredClone(DEFAULT_MEMBER), bio: 'hello' };
  assert.equal(isEmptyMember(withBio), false);

  // economyInitialised alone is re-derivable and must not keep a row alive.
  const initialisedOnly = { ...structuredClone(DEFAULT_MEMBER), economyInitialised: true };
  assert.equal(isEmptyMember(initialisedOnly), true);
});

test('housekeeping prunes stale records and keeps live ones', async () => {
  const dataDir = tempDir('bot-maint-');
  const db = new Database({ dataDir, saveIntervalMs: 60_000, backupCount: 0 });

  const day = 86_400_000;
  const now = Date.now();
  const guildId = '1';

  // Two polls: one closed long ago, one still running.
  db.stores.guilds.set(`${guildId}.pollData.old`, { closed: true, closedAt: now - 60 * day, question: 'old' });
  db.stores.guilds.set(`${guildId}.pollData.live`, { closed: false, endsAt: now + day, question: 'live' });

  // Two suggestions: one resolved long ago, one open.
  db.stores.guilds.set(`${guildId}.suggestionData.old`, { status: 'approved', resolvedAt: now - 200 * day });
  db.stores.guilds.set(`${guildId}.suggestionData.open`, { status: 'open', createdAt: now - 200 * day });

  // Two starboard entries.
  db.stores.starboard.set(`${guildId}.ancient`, { at: now - 200 * day, count: 5 });
  db.stores.starboard.set(`${guildId}.recent`, { at: now - day, count: 5 });

  // Three member records: empty, active, and one with real data.
  db.member(guildId, 'empty-lookup');
  const active = db.member(guildId, 'active');
  active.xp = 5000;
  active.coins = 100;
  const talker = db.member(guildId, 'talker');
  talker.messages = 42;
  db.saveMember();

  // Minimal bot stand-in: the maintenance feature only touches these.
  const noop = () => {};
  const bot = {
    log: { child: () => ({ info: noop, warn: noop, debug: noop, error: noop }) },
    db,
    features: {},
    client: null,
    cacheProfile: { profile: 'balanced', meta: cache.PROFILES.balanced },
    scheduler: {
      register: noop,
      find: () => [],
      scheduleIn: noop,
      cancelWhere: () => 0,
    },
  };

  const maintenance = require('../src/features/maintenance').init(bot);
  const result = maintenance.run();

  assert.equal(result.polls, 1, 'the closed old poll should go');
  assert.equal(result.suggestions, 1, 'the resolved old suggestion should go');
  assert.equal(result.starboard, 1, 'the ancient starboard entry should go');
  assert.equal(result.members, 1, 'only the empty lookup artefact should go');

  assert.equal(db.stores.guilds.get(`${guildId}.pollData.old`), undefined);
  assert.ok(db.stores.guilds.get(`${guildId}.pollData.live`), 'a running poll must survive');
  assert.ok(db.stores.guilds.get(`${guildId}.suggestionData.open`), 'an open suggestion must survive');
  assert.ok(db.stores.starboard.get(`${guildId}.recent`), 'a recent starboard entry must survive');

  const remaining = db.members(guildId).map(([id]) => id).sort();
  assert.deepEqual(remaining, ['active', 'talker'], 'members with real data must survive');

  maintenance.shutdown();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('housekeeping dry run changes nothing', async () => {
  const dataDir = tempDir('bot-maint-');
  const db = new Database({ dataDir, saveIntervalMs: 60_000, backupCount: 0 });

  db.stores.guilds.set('1.pollData.old', { closed: true, closedAt: Date.now() - 60 * 86_400_000 });

  const noop = () => {};
  const bot = {
    log: { child: () => ({ info: noop, warn: noop, debug: noop, error: noop }) },
    db,
    features: {},
    client: null,
    cacheProfile: { profile: 'balanced', meta: cache.PROFILES.balanced },
    scheduler: { register: noop, find: () => [], scheduleIn: noop, cancelWhere: () => 0 },
  };

  const maintenance = require('../src/features/maintenance').init(bot);
  const result = maintenance.run({ dryRun: true });

  assert.equal(result.polls, 1, 'a dry run still reports what it would remove');
  assert.ok(db.stores.guilds.get('1.pollData.old'), 'but must not actually remove it');

  maintenance.shutdown();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the log ring buffer cannot grow without bound', () => {
  const { buffer, Logger } = require('../src/core/logger');
  const before = buffer.items.length;
  const log = new Logger('test-growth', { level: 'silent' });

  for (let i = 0; i < 2000; i++) log.info(`line ${i}`);

  assert.ok(buffer.items.length <= buffer.size, `ring buffer holds ${buffer.items.length}, cap is ${buffer.size}`);
  assert.ok(buffer.items.length >= Math.min(before + 1, buffer.size));
  // The newest entry must be retained; it is the oldest that gets dropped.
  assert.match(buffer.items[buffer.items.length - 1].msg, /line 1999/);
});

// ---------------------------------------------------------------------------
test('the invite link asks for what the commands actually need', () => {
  const perms = require('../src/util/perms');
  const { PermissionFlagsBits } = require('discord.js');
  const fs = require('node:fs');
  const path = require('node:path');

  // Collect every permission the commands declare as botPerms, then check the
  // invite covers all of them. The regression this guards: /botinfo carried a
  // hardcoded integer that had drifted out of sync, so following the bot's own
  // invite link produced a bot missing Manage Messages, Manage Roles and
  // Manage Channels — and half the features answered "I am missing X".
  const declared = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        // Only the botPerms arrays: userPerms are checked on the invoker.
        for (const block of source.matchAll(/botPerms:\s*\[([^\]]*)\]/g)) {
          for (const m of block[1].matchAll(/PermissionFlagsBits\.(\w+)/g)) declared.add(m[1]);
        }
      }
    }
  };
  walk(path.join(__dirname, '..', 'src', 'commands'));

  assert.ok(declared.size > 0, 'no botPerms were found to check against');

  for (const name of declared) {
    assert.ok(
      (perms.REQUIRED_PERMISSIONS_BITS & PermissionFlagsBits[name]) !== 0n,
      `a command declares botPerms ${name} but the invite link does not request it`,
    );
  }

  // And the reverse direction: nothing dangerous crept in.
  for (const forbidden of ['Administrator', 'ManageGuild', 'MentionEveryone', 'ManageWebhooks']) {
    assert.equal(
      (perms.REQUIRED_PERMISSIONS_BITS & PermissionFlagsBits[forbidden]) === 0n,
      true,
      `the invite link must not request ${forbidden}`,
    );
  }

  assert.match(perms.inviteUrl('123'), /client_id=123.*scope=bot%20applications\.commands/);
});

// ---------------------------------------------------------------------------
test('command registration targets the servers the bot is actually in', async () => {
  // Global registration takes Discord up to an hour to propagate. For someone
  // self-hosting in one server that hour is spent wondering whether the setup
  // is broken, and the stock answer — "set GUILD_ID" — means hunting for a
  // snowflake in a UI where Developer Mode is off by default. So with no
  // GUILD_ID and a handful of servers, each is registered directly instead.
  const Bot = require('../src/bot');
  const discord = require('discord.js');

  const cases = [
    { label: 'one server, no GUILD_ID', guilds: ['1'], env: '', expect: 'guild', calls: 1 },
    { label: 'three servers, no GUILD_ID', guilds: ['1', '2', '3'], env: '', expect: 'guild', calls: 3 },
    { label: 'explicit GUILD_ID wins', guilds: ['1', '2', '3'], env: '9', expect: 'guild', calls: 1 },
    { label: 'past the threshold, go global', guilds: ['1', '2', '3', '4', '5', '6'], env: '', expect: 'global', calls: 1 },
    { label: 'no servers yet', guilds: [], env: '', expect: 'global', calls: 1 },
  ];

  for (const testCase of cases) {
    process.env.GUILD_ID = testCase.env;
    process.env.PLUGINS_DIR = tempDir('reg-p-');
    process.env.DATA_DIR = tempDir('reg-d-');
    process.env.LOG_LEVEL = 'silent';
    delete process.env.REGISTER_COMMANDS;

    const bot = new Bot({ token: 'x.y.z', rootDir: path.join(__dirname, '..'), discord });
    await bot.init();

    for (const id of testCase.guilds) bot.client.guilds.cache.set(id, { id, name: `server-${id}` });
    Object.defineProperty(bot.client, 'user', { value: { id: 'app' }, configurable: true });

    const routes = [];
    const originalPut = discord.REST.prototype.put;
    const originalGet = discord.REST.prototype.get;
    discord.REST.prototype.put = async function put(route) {
      routes.push(route);
    };
    // No stale global commands in these cases.
    discord.REST.prototype.get = async function get() {
      return [];
    };

    const result = await bot.registerCommands();
    discord.REST.prototype.put = originalPut;
    discord.REST.prototype.get = originalGet;

    assert.equal(result.scope, testCase.expect, `${testCase.label}: expected ${testCase.expect} scope`);
    assert.equal(routes.length, testCase.calls, `${testCase.label}: expected ${testCase.calls} REST call(s)`);
    if (testCase.expect === 'guild') {
      assert.ok(routes.every((r) => r.includes('/guilds/')), `${testCase.label}: should use the guild route`);
    }

    await bot.shutdown();
  }

  delete process.env.GUILD_ID;
});

test('a stale global registration is cleared when registering per guild', async () => {
  // Guild and global command sets are independent and Discord shows both. A bot
  // that once registered globally and now registers per guild would list every
  // command twice as the old global set finished propagating — which looks like
  // a bug and no restart fixes, because nothing removes the old set.
  const Bot = require('../src/bot');
  const discord = require('discord.js');

  process.env.GUILD_ID = '';
  process.env.PLUGINS_DIR = tempDir('stale-p-');
  process.env.DATA_DIR = tempDir('stale-d-');
  process.env.LOG_LEVEL = 'silent';
  delete process.env.REGISTER_COMMANDS;

  const bot = new Bot({ token: 'x.y.z', rootDir: path.join(__dirname, '..'), discord });
  await bot.init();
  bot.client.guilds.cache.set('111', { id: '111', name: 'server' });
  Object.defineProperty(bot.client, 'user', { value: { id: 'app' }, configurable: true });

  const puts = [];
  const originalPut = discord.REST.prototype.put;
  const originalGet = discord.REST.prototype.get;

  discord.REST.prototype.put = async function put(route, options) {
    puts.push({ route, count: options?.body?.length ?? 0 });
  };
  // Pretend an earlier run left a full global set behind.
  discord.REST.prototype.get = async function get() {
    return Array.from({ length: 73 }, (_, i) => ({ name: `cmd${i}` }));
  };

  await bot.registerCommands();

  discord.REST.prototype.put = originalPut;
  discord.REST.prototype.get = originalGet;
  await bot.shutdown();

  const guildPut = puts.find((p) => p.route.includes('/guilds/'));
  const globalPut = puts.find((p) => !p.route.includes('/guilds/'));

  assert.ok(guildPut, 'commands should be registered to the guild');
  assert.ok(guildPut.count > 0, 'the guild registration should carry the command set');
  assert.ok(globalPut, 'the stale global set should have been cleared');
  assert.equal(globalPut.count, 0, 'clearing means an empty body, not a re-register');
});

// ---------------------------------------------------------------------------
test('a read-only data directory fails loudly instead of relocating', async () => {
  // Containers are increasingly read-only with only /tmp writable. Silently
  // moving the data directory to /tmp would look like it worked and then lose
  // every server's settings on the next restart, repeatedly, with no sign
  // anything was wrong. So this one reports and stops.
  const Bot = require('../src/bot');
  const discord = require('discord.js');

  const base = tempDir('ro-');
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'a file where a directory is wanted');

  process.env.DATA_DIR = blocked;
  process.env.PLUGINS_DIR = base;
  process.env.LOG_LEVEL = 'silent';
  process.env.REGISTER_COMMANDS = 'false';

  const bot = new Bot({ token: 'x.y.z', rootDir: path.join(__dirname, '..'), discord });
  await assert.rejects(() => bot.init(), /not writable/, 'init must refuse to start');

  fs.rmSync(base, { recursive: true, force: true });
});

test('a read-only plugins directory falls back, and says so', async () => {
  // Unlike the data directory, relocating an install is reasonable: the code
  // came from elsewhere and can be fetched again. The requirement is that the
  // result reports it, so nobody is surprised when it is gone after a restart.
  const writable = require('../src/core/writable');
  const Bot = require('../src/bot');
  const discord = require('discord.js');
  const http = require('node:http');

  const base = tempDir('ro2-');
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');

  assert.equal(writable.check(base).ok, true, 'a normal directory is writable');
  assert.equal(writable.check(blocked).ok, false, 'a blocked path is not');

  process.env.DATA_DIR = tempDir('ro2-d-');
  process.env.PLUGINS_DIR = blocked;
  process.env.LOG_LEVEL = 'silent';
  process.env.REGISTER_COMMANDS = 'false';

  const bot = new Bot({ token: 'x.y.z', rootDir: path.join(__dirname, '..'), discord });
  await bot.init();

  const port = 34_100 + (process.pid % 300);
  const origin = http.createServer((q, s) => {
    s.writeHead(200);
    s.end("plugin.store.set('ok', 1);");
  });
  await new Promise((r) => origin.listen(port, '127.0.0.1', r));

  const result = await bot.plugins.installFromUrl(`http://127.0.0.1:${port}/p.js`, { name: 'ro' });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.temporary, true, 'the caller must be told the install is temporary');
  assert.equal(bot.plugins.get('ro').state, 'loaded', 'and it must actually run');
  assert.equal(fs.existsSync(path.join(blocked, 'ro.js')), false, 'nothing was written to the read-only path');

  origin.close();
  await bot.shutdown();
  fs.rmSync(base, { recursive: true, force: true });
});
