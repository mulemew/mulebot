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
