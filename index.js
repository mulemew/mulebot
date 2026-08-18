/**
 * Discord Bot - entry point
 *
 * Start:  node index.js
 * Config: DISCORD_TOKEN via a real environment variable, a local .env file,
 *         or the --token= argument.
 *
 * This file deliberately stays small and dependency-light. Its only jobs are:
 *   1. make the runtime environment legible in the log before anything can fail
 *   2. resolve a usable token
 *   3. hand control to src/bot.js
 *   4. log in, degrading gracefully when privileged intents are switched off
 *   5. flush state to disk on shutdown
 *
 * Everything else lives under src/. See src/bot.js for the wiring.
 */

'use strict';

// Loads a local .env if present. Real environment variables take precedence and
// are never overwritten by .env. If you inject env vars through systemd, Docker
// or a PaaS panel you can skip the .env file entirely - and even skip dotenv,
// since a missing package is tolerated here.
const fs = require('node:fs');
const path = require('node:path');

// Before anything else, and before anything heavy is loaded: V8 sizes its heap
// from host memory and cannot see a container limit, so on a small host it plans
// for gigabytes it does not have. --max-old-space-size only works if it is set
// before the process starts, which no config file can do - so the process
// re-launches itself once with the right value. See src/core/heap.js for the
// conditions; on an ordinary machine this is a few microseconds and a no-op.
// Where execve is available this never returns - the process image is replaced
// and the file starts again from the top with the flag applied. Where it is not,
// a child was started to be the real bot, and this process is now only a
// supervisor forwarding signals to it: it must not go on to start a second bot,
// hence the return. (Top-level return is legal here; a CommonJS file is a
// function body.)
if (require('./src/core/heap').autosize({ log: (line) => process.stdout.write(line + '\n') }).relaunched) {
  return;
}

let dotenvLoaded = false;
try {
  require('dotenv').config({ quiet: true });
  dotenvLoaded = true;
} catch {
  // dotenv is an optional dependency. Missing it is fine when the environment
  // is injected by systemd, Docker or a panel - but if a .env file exists and
  // nothing read it, every setting in that file is being silently ignored.
  // Staying quiet there costs hours of "why is my token not working".
  if (fs.existsSync(path.join(__dirname, '.env'))) {
    process.stdout.write(
      '[WARN] A .env file exists but the "dotenv" package is not installed, so it was NOT read.\n' +
        '       Install it with:  npm install dotenv\n' +
        '       or pass the settings as real environment variables instead.\n',
    );
  }
}

// Every diagnostic goes to stdout on purpose. Hosting panels such as
// Pterodactyl, Pelican and FeatherPanel stream stdout to their console and
// often drop stderr entirely, which would hide the reason for any crash.
// Error objects are expanded to their stack so panel logs stay useful; joining
// them naively would collapse everything into a useless "[object Object]".
const bootLog = (...args) =>
  process.stdout.write(
    args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ') + '\n',
  );

// discord.js is loaded through a guard so a missing dependency produces a clear
// stdout message instead of a raw MODULE_NOT_FOUND stack on stderr, which hosting
// panels hide. Without this the console shows only "exit code 1" and no reason.
let discord;
try {
  discord = require('discord.js');
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    bootLog('[FATAL] Dependencies are not installed - discord.js is missing.');
    bootLog('Run this once in the folder that holds index.js and package.json:');
    bootLog('  npm install');
    bootLog('On a hosting panel, make sure the startup command runs npm install, e.g.:');
    bootLog('  if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi');
    process.exit(1);
  }
  bootLog('[FATAL] Failed to load discord.js:', e);
  process.exit(1);
}

const { version: djsVersion } = discord;

// ---------- Token resolution ----------
// Order:
//   1. --token=xxx command line argument
//   2. DISCORD_TOKEN environment variable (or .env file)
//   3. Interactive prompt on first run, which offers to save into .env
const cliToken = process.argv
  .find((a) => a.startsWith('--token='))
  ?.slice('--token='.length);

const ENV_FILE = path.join(__dirname, '.env');

/**
 * Cleans up the most common ways a pasted token gets mangled: surrounding
 * quotes copied from a config file, a leading "Bot " prefix copied from API
 * docs, and stray whitespace or newlines from a panel input field. Discord
 * rejects all of those with a generic "invalid token", so normalising here
 * removes a whole class of confusing failures.
 */
function normalizeToken(raw) {
  let t = String(raw ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/^Bot\s+/i, '').trim();
  return t;
}

/**
 * Describes a token without leaking it, so panel logs stay safe to paste.
 * Only the length and segment shape are reported.
 */
function describeToken(t) {
  const parts = t.split('.');
  const shape = parts.map((p) => p.length).join('.');
  return `length ${t.length}, ${parts.length} segment(s), shape ${shape}`;
}

/**
 * Asks for the token interactively when nothing was configured.
 * Returns the entered token, or an empty string if input is unavailable.
 */
async function promptForToken() {
  // A prompt only makes sense on an interactive terminal. Under Docker,
  // systemd or CI there is no TTY, so fail fast with instructions instead.
  if (!process.stdin.isTTY) {
    bootLog('[FATAL] No DISCORD_TOKEN configured and no interactive terminal available.');
    bootLog('Provide the token in any of these ways:');
    bootLog('  - Panel: add DISCORD_TOKEN as a startup/environment variable');
    bootLog('  - .env file next to index.js:  DISCORD_TOKEN=your_token');
    bootLog('  - shell:                       DISCORD_TOKEN=your_token node index.js');
    bootLog('  - argument:                    node index.js --token=your_token');
    return '';
  }

  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  bootLog('No bot token found. A token is required because Discord authenticates every bot with one.');
  bootLog('Get yours at https://discord.com/developers/applications -> your app -> Bot -> Reset Token');
  bootLog('');

  const entered = normalizeToken(await ask('Paste your bot token: '));
  if (!entered) {
    rl.close();
    bootLog('[FATAL] No token entered, stopping.');
    return '';
  }

  // Discord tokens are three dot-separated segments. Warn but do not block,
  // since the format is not formally guaranteed.
  if (entered.split('.').length !== 3) {
    bootLog('[WARN] That does not look like a standard bot token. Continuing anyway.');
  }

  const save = (await ask('Save it to .env so you are not asked again? [Y/n] ')).trim().toLowerCase();
  rl.close();

  if (save === '' || save === 'y' || save === 'yes') {
    try {
      if (fs.existsSync(ENV_FILE)) {
        // Never clobber an existing .env: append only if the key is absent
        const current = fs.readFileSync(ENV_FILE, 'utf8');
        if (/^\s*DISCORD_TOKEN\s*=/m.test(current)) {
          bootLog('[WARN] .env already defines DISCORD_TOKEN, leaving the file untouched.');
        } else {
          fs.appendFileSync(ENV_FILE, `${current.endsWith('\n') ? '' : '\n'}DISCORD_TOKEN=${entered}\n`);
          bootLog('[OK] Appended DISCORD_TOKEN to the existing .env');
        }
      } else {
        fs.writeFileSync(ENV_FILE, `DISCORD_TOKEN=${entered}\n`, { mode: 0o600 });
        bootLog('[OK] Saved to .env (readable only by you)');
      }
    } catch (e) {
      bootLog('[ERROR] Could not write .env, continuing without saving:', e.message);
    }
  }

  bootLog('');
  return entered;
}

// ---------- Process level safety nets ----------
// Installed before anything else so even a failure during construction is
// reported rather than silently killing the process.
process.on('unhandledRejection', (e) => bootLog('[UNHANDLED REJECTION]', e));
process.on('uncaughtException', (e) => bootLog('[UNCAUGHT EXCEPTION]', e));

// ---------- Start ----------
(async () => {
  // Boot banner: printed before anything can fail, so a crashed container still
  // shows what the environment looked like.
  bootLog('--------------------------------------------------');
  bootLog(`Node ${process.version} | discord.js v${djsVersion} | platform ${process.platform}`);
  bootLog(`Working directory: ${process.cwd()}`);
  bootLog(`Script directory:  ${__dirname}`);
  bootLog(
    `Token source:      ${
      cliToken ? '--token argument' : process.env.DISCORD_TOKEN ? 'environment variable or .env' : 'not configured yet'
    }`,
  );
  bootLog(`Interactive TTY:   ${process.stdin.isTTY ? 'yes' : 'no'}`);
  bootLog('--------------------------------------------------');

  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  if (major < 18) {
    bootLog(`[FATAL] Node ${major} is too old. discord.js v14 needs Node 18 or newer.`);
    process.exit(1);
  }

  // package.json asks for 22.15+, but a host that ignores "engines" will happily
  // run this on 18. It works - it just costs a whole extra process, so the cost
  // is stated here rather than left to be discovered in a memory graph.
  if (typeof process.execve !== 'function' && process.platform !== 'win32') {
    bootLog(`[WARN] Node ${process.version} predates process.execve (added in 22.15).`);
    bootLog('       On a memory-limited host the bot must run itself as a child process to');
    bootLog('       cap the V8 heap, which costs about 45 MB. Node 22.15+ avoids that.');
  }
  if (major % 2 !== 0) {
    bootLog(`[WARN] Node ${major} is an odd-numbered, non-LTS release. If you hit odd runtime`);
    bootLog('       errors, switching the container image to Node 22 LTS is more reliable.');
  }

  let TOKEN = normalizeToken(cliToken || process.env.DISCORD_TOKEN || '');
  if (!TOKEN) TOKEN = await promptForToken();
  if (!TOKEN) process.exit(1);

  // Never print the token itself, only its shape, so logs can be shared safely.
  bootLog(`Token check:       ${describeToken(TOKEN)}`);
  if (TOKEN.split('.').length !== 3) {
    bootLog('[WARN] A bot token normally has 3 dot-separated segments. This value does not,');
    bootLog('       which usually means a client secret, application ID, public key or an');
    bootLog('       incomplete copy was pasted instead of the bot token.');
  }
  bootLog('--------------------------------------------------');

  // The whole application is built here. Any error thrown while loading a
  // command or feature module surfaces with a readable message instead of a
  // half-started bot.
  let Bot;
  try {
    Bot = require('./src/bot');
  } catch (e) {
    bootLog('[FATAL] Failed to load the bot source tree:', e);
    bootLog('If a file under src/ was edited by hand, the stack above points at it.');
    process.exit(1);
  }

  const bot = new Bot({ token: TOKEN, rootDir: __dirname, discord });

  try {
    await bot.init();
  } catch (e) {
    bootLog('[FATAL] Initialisation failed:', e);
    process.exit(1);
  }

  // ---------- Graceful shutdown ----------
  // Panels send SIGTERM on stop/restart. Flushing here means an in-flight
  // economy transaction or level-up is never lost to a restart.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // State at the moment the signal arrived, because that is the one question
    // the log cannot otherwise answer: a platform that stops a container for
    // exceeding its memory allowance and a platform that stops it for any other
    // reason send the identical signal, and the difference is only visible in
    // these numbers.
    const mem = process.memoryUsage();
    const mb = (n) => Math.round(n / 1024 / 1024);
    const limit = require('./src/core/cache').containerMemoryLimitMb();
    bootLog(
      `[SHUTDOWN] ${signal} received after ${Math.round((Date.now() - bot.startedAt) / 1000)}s — ` +
        `rss ${mb(mem.rss)}MB, heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB, external ${mb(mem.external)}MB` +
        (limit ? `, limit ${limit}MB` : ''),
    );
    bootLog('[SHUTDOWN] flushing state...');
    try {
      await bot.shutdown();
      bootLog('[SHUTDOWN] State flushed, exiting cleanly.');
    } catch (e) {
      bootLog('[SHUTDOWN] Flush failed:', e);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ---------- Login ----------
  // Privileged intents are opt-in switches in the developer portal. Rather than
  // refusing to start over one checkbox, the bot walks down a ladder of intent
  // sets and reports exactly which features each downgrade costs.
  try {
    await bot.login();
  } catch (e) {
    const msg = e?.message || String(e);
    bootLog('[FATAL] Login failed:', msg);

    if (/invalid token|401|unauthorized/i.test(msg)) {
      bootLog('Discord rejected the token itself. Intents are NOT the cause of this error.');
      bootLog(`What was loaded: ${describeToken(TOKEN)}`);
      bootLog('Most common causes, in order:');
      bootLog('  1. The token was reset. Every reset invalidates the old one immediately.');
      bootLog('  2. The wrong value was copied. The bot token is under the Bot tab, not the');
      bootLog('     OAuth2 client secret, not the Application ID, not the Public Key.');
      bootLog('  3. The copy is incomplete or has a stray quote, space or newline.');
      bootLog('  4. A "Bot " prefix was included. Only the raw token belongs here.');
      bootLog('Fix: open the developer portal -> your app -> Bot -> Reset Token, copy the');
      bootLog('new value in full, and paste it into the panel startup variable.');
    } else {
      bootLog('Unexpected login failure. The full error is above.');
    }
    process.exit(1);
  }
})();
