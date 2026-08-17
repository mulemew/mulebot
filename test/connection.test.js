'use strict';

/**
 * Gateway resilience tests.
 *
 * The failure being guarded against is not a crash — it is the opposite. With
 * no handler for these events the process stays alive with a dead gateway,
 * doing nothing, and never exits, so no supervisor restarts it. These tests
 * assert the two halves: recoverable problems keep the process running, and
 * unrecoverable ones end it with a non-zero code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const discord = require('discord.js');
const Bot = require('../src/bot');

const ROOT = path.join(__dirname, '..');
const tempDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function boot() {
  process.env.PLUGINS_DIR = tempDir('conn-plugins-');
  process.env.DATA_DIR = tempDir('conn-data-');
  process.env.LOG_LEVEL = 'silent';
  process.env.REGISTER_COMMANDS = 'false';

  const bot = new Bot({ token: 'x.y.z', rootDir: ROOT, discord });
  await bot.init();
  bot.readyAt = Date.now();
  return bot;
}

/** Runs a scenario in a child process so its exit code can be observed. */
function runScenario(scenario, { ready = true } = {}) {
  const script = `
    process.env.PLUGINS_DIR = ${JSON.stringify(tempDir('conn-p-'))};
    process.env.DATA_DIR = ${JSON.stringify(tempDir('conn-d-'))};
    process.env.LOG_LEVEL = 'silent';
    process.env.REGISTER_COMMANDS = 'false';
    const discord = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'discord.js'))});
    const Bot = require(${JSON.stringify(path.join(ROOT, 'src', 'bot.js'))});
    (async () => {
      const bot = new Bot({ token: 'x.y.z', rootDir: ${JSON.stringify(ROOT)}, discord });
      await bot.init();
      ${ready ? 'bot.readyAt = Date.now();' : '// deliberately not ready: still inside the login ladder'}
      ${scenario}
      // If nothing exits within a second, the handler did not do its job.
      setTimeout(() => process.exit(42), 1500);
    })();
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
}

// ---------------------------------------------------------------------------

test('every gateway lifecycle event has a listener', async (t) => {
  const bot = await boot();
  t.after(() => bot.shutdown());

  for (const event of [
    'error',
    'shardError',
    'shardDisconnect',
    'shardReconnecting',
    'shardResume',
    'shardReady',
    'invalidated',
    'warn',
    'rateLimited',
  ]) {
    assert.ok(bot.client.listenerCount(event) > 0, `no listener for "${event}"`);
  }
});

test("an emitted 'error' is handled rather than thrown", async (t) => {
  const bot = await boot();
  t.after(() => bot.shutdown());

  // EventEmitter throws when 'error' is emitted with no listener. That would
  // surface as an uncaught exception, which the process handler logs and then
  // continues past — leaving a live process with a dead gateway.
  const before = bot.counters.errors;
  assert.doesNotThrow(() => bot.client.emit('error', new Error('simulated')));
  assert.equal(bot.counters.errors, before + 1, 'the error should be counted');
});

test('a recoverable disconnect does not end the process', async (t) => {
  const bot = await boot();
  t.after(() => bot.shutdown());

  // 1006 is an abnormal closure: a dropped connection, a Discord blip. discord.js
  // reconnects on its own, so the right response is to log and wait.
  assert.doesNotThrow(() => bot.client.emit('shardDisconnect', { code: 1006 }, 0));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(true, 'still running');
});

test('a fatal close code during login is left to the intent ladder', () => {
  // The regression this guards, which shipped and broke real deployments:
  // login() walks an intent-fallback ladder that deliberately provokes a 4014
  // "disallowed intents" close and retries with fewer intents. The connection
  // handlers are attached from the first loadEvents(), so they are live during
  // that ladder — and exiting on 4014 killed the process mid-fallback, before
  // the retry that would have succeeded.
  //
  // Note readyAt is NOT set here: that is the whole distinction.
  const result = runScenario(`bot.client.emit('shardDisconnect', { code: 4014 }, 0);`, { ready: false });
  assert.equal(result.status, 42, `expected the process to survive (42), got ${result.status}\n${result.stderr}`);
});

test('an invalidated session during login is left to login()', () => {
  const result = runScenario(`bot.client.emit('invalidated');`, { ready: false });
  assert.equal(result.status, 42, `expected the process to survive (42), got ${result.status}`);
});

test('an unrecoverable close code exits non-zero', () => {
  // 4004 is authentication failure: the token was reset or is wrong. discord.js
  // will not retry, so staying alive would be a zombie.
  const result = runScenario(`bot.client.emit('shardDisconnect', { code: 4004 }, 0);`);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stderr}`);
});

test('an invalidated session exits non-zero', () => {
  // Fires when the bot application is deleted or the token reset while running.
  // discord.js has already destroyed the client at this point.
  const result = runScenario(`bot.client.emit('invalidated');`);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stderr}`);
});

test('a disallowed-intent close is treated as fatal, not retried', () => {
  const result = runScenario(`bot.client.emit('shardDisconnect', { code: 4014 }, 0);`);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
});
