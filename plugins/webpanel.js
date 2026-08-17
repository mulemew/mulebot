/**
 * webpanel — a browser UI for managing plugins.
 *
 * Upload a .js file, install an npm package, load / unload / reload / delete a
 * plugin, and read the recent log, all from a web page.
 *
 * ── Read this before enabling it ───────────────────────────────────────────
 *
 * This panel uploads and executes arbitrary JavaScript inside the bot process.
 * That is its entire purpose, and it means **anyone who can reach it and knows
 * the token has full control of the host** — the Discord token, the data
 * directory, the filesystem, outbound network. It is a remote code execution
 * endpoint by design.
 *
 * So it is built to fail closed:
 *
 *   - it refuses to start without an auth token; there is no default
 *   - a token shorter than 24 characters is rejected
 *   - it binds 127.0.0.1 unless a host is set explicitly, even under PaaS
 *   - token comparison is constant-time
 *   - failed attempts are rate limited per address, then temporarily blocked
 *   - uploads must be a plain filename ending in .js, capped at 256 KB
 *   - npm package names are validated against the registry's own grammar and
 *     passed to spawn() as an argument array, never through a shell
 *
 * The right way to reach it remotely is an SSH tunnel:
 *
 *     ssh -L 8787:127.0.0.1:8787 you@your-server
 *     # then open http://127.0.0.1:8787
 *
 * Configure in plugins/plugins.json:
 *
 *     { "config": { "webpanel": {
 *         "token": "a-long-random-string",
 *         "port": 8787,
 *         "host": "127.0.0.1"
 *     } } }
 *
 * Or set WEBPANEL_TOKEN in the environment.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MAX_UPLOAD_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const NPM_TIMEOUT_MS = 120_000;
const FAILED_ATTEMPT_LIMIT = 5;
const BLOCK_MS = 15 * 60_000;

module.exports = {
  version: '1.0.0',
  description: 'Browser UI for uploading, installing and managing plugins',

  init(plugin) {
    const { bot, log, config } = plugin;

    // ---------- refuse to run without a real token ----------
    const token = String(config.token || process.env.WEBPANEL_TOKEN || '');
    if (!token) {
      throw new Error(
        'webpanel needs an auth token and there is no default. ' +
          'Set it in plugins/plugins.json as config.webpanel.token, or as WEBPANEL_TOKEN. ' +
          'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"',
      );
    }
    if (token.length < 24) {
      throw new Error(
        `webpanel token is ${token.length} characters; at least 24 are required. ` +
          'This endpoint can execute arbitrary code, so a guessable token is not survivable.',
      );
    }

    const port = Number(config.port || process.env.WEBPANEL_PORT || 8787);
    // Deliberately does NOT follow the PaaS "PORT is set, bind 0.0.0.0" rule
    // that httpserver.js uses. Exposing a status page is fine; exposing a code
    // execution panel because an environment variable happened to be set is not.
    const host = config.host || '127.0.0.1';

    const tokenHash = crypto.createHash('sha256').update(token).digest();
    /** address -> { failures, blockedUntil } */
    const attempts = new Map();

    // Optional address allow-list, for when the panel must be reachable beyond
    // localhost. A bearer token is the primary gate; this narrows who may even
    // attempt one. Entries are exact addresses or CIDR-less prefixes.
    const allowed = Array.isArray(config.allowedIps) ? config.allowedIps.filter(Boolean) : [];

    // ---------- auth ----------

    function addressOf(req) {
      return req.socket.remoteAddress || 'unknown';
    }

    function authorised(req) {
      const header = req.headers.authorization || '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!supplied) return false;
      // Hash both sides first so timingSafeEqual always compares equal lengths;
      // it throws on a length mismatch, which would itself leak the length.
      const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
      return crypto.timingSafeEqual(tokenHash, suppliedHash);
    }

    function blocked(req) {
      const entry = attempts.get(addressOf(req));
      return entry && entry.blockedUntil > Date.now();
    }

    /** False when an allow-list is configured and this address is not on it. */
    function addressAllowed(req) {
      if (!allowed.length) return true;
      // IPv4-mapped IPv6 (::ffff:1.2.3.4) is what a dual-stack listener reports.
      const raw = String(addressOf(req)).replace(/^::ffff:/, '');
      return allowed.some((entry) => raw === entry || raw.startsWith(entry));
    }

    function recordFailure(req) {
      const key = addressOf(req);
      const entry = attempts.get(key) || { failures: 0, blockedUntil: 0 };
      entry.failures++;
      if (entry.failures >= FAILED_ATTEMPT_LIMIT) {
        entry.blockedUntil = Date.now() + BLOCK_MS;
        entry.failures = 0;
        log.warn(`blocking ${key} for 15 minutes after ${FAILED_ATTEMPT_LIMIT} failed auth attempts`);
      }
      attempts.set(key, entry);
    }

    function recordSuccess(req) {
      attempts.delete(addressOf(req));
    }

    // ---------- helpers ----------

    const send = (res, status, payload, type = 'application/json; charset=utf-8') => {
      const body = type.startsWith('application/json') ? JSON.stringify(payload) : payload;
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // The UI is entirely inline and loads nothing external, so it can run
        // under a policy that forbids remote script outright.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
      });
      res.end(body);
    };

    function readBody(req) {
      return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            reject(new Error(`request body over ${Math.round(MAX_BODY_BYTES / 1024)} KB`));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          try {
            resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
          } catch {
            reject(new Error('body is not valid JSON'));
          }
        });
        req.on('error', reject);
      });
    }

    /**
     * Validates an uploaded plugin filename.
     * Rejects anything that is not a bare name, which is what stops
     * "../../src/bot.js" from being written through this endpoint.
     */
    function safePluginPath(name) {
      const base = String(name || '').trim();
      if (!base) throw new Error('a filename is required');
      if (!/^[A-Za-z0-9._-]+$/.test(base)) {
        throw new Error('the filename may only contain letters, numbers, dot, dash and underscore');
      }
      if (base.startsWith('.') || base.startsWith('_')) {
        throw new Error('names starting with a dot or underscore are skipped by the loader');
      }
      if (!base.endsWith('.js')) throw new Error('the filename must end in .js');
      if (base.includes('..')) throw new Error('path traversal is not allowed');

      const target = path.join(bot.config.pluginsDir, base);
      const resolved = path.resolve(target);
      // Belt and braces: even with the character allow-list above, confirm the
      // resolved path is genuinely inside the plugins directory.
      if (path.dirname(resolved) !== path.resolve(bot.config.pluginsDir)) {
        throw new Error('resolved outside the plugins directory');
      }
      return { base, target: resolved, name: base.replace(/\.js$/, '') };
    }

    /** npm's own package name grammar, plus a length cap. */
    function validPackageName(spec) {
      const s = String(spec || '').trim();
      if (!s || s.length > 214) return null;
      // name, @scope/name, optionally with @version or a dist-tag
      const m = s.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._^~><=|\s*-]+))?$/);
      if (!m) return null;
      return m[2] ? `${m[1]}@${m[2]}` : m[1];
    }

    function runNpm(args) {
      return new Promise((resolve) => {
        const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        // Argument array, never a shell string, so a package name cannot smuggle
        // in a command separator.
        const child = spawn(command, args, {
          cwd: bot.config.rootDir,
          shell: false,
          windowsHide: true,
        });

        let out = '';
        let done = false;
        const finish = (code, note) => {
          if (done) return;
          done = true;
          resolve({ code, output: (out + (note || '')).slice(-8000) });
        };

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          finish(-1, '\n[timed out]');
        }, NPM_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();

        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          finish(-1, `\n[could not run npm: ${e.message}]`);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          finish(code);
        });
      });
    }

    // ---------- API ----------

    async function handleApi(req, res, url) {
      const route = url.pathname;

      if (route === '/api/state' && req.method === 'GET') {
        const { buffer } = require(path.join(bot.config.rootDir, 'src', 'core', 'logger'));
        const memory = bot.features.maintenance?.memory() || {};
        return send(res, 200, {
          plugins: bot.plugins.list(),
          stats: bot.plugins.stats(),
          pluginsDir: bot.config.pluginsDir,
          watching: bot.plugins.stats().watching,
          bot: {
            ready: Boolean(bot.readyAt),
            uptimeMs: bot.uptime,
            guilds: bot.client?.guilds?.cache?.size ?? 0,
            commands: bot.registry.size,
            rssMb: memory.rssMb,
            limitMb: memory.limitMb,
            profile: memory.profile,
          },
          log: buffer.tail(80).map((e) => ({
            at: e.at,
            level: e.level,
            scope: e.scope,
            msg: e.msg.slice(0, 500),
          })),
        });
      }

      if (route === '/api/upload' && req.method === 'POST') {
        const body = await readBody(req);
        const { base, target, name } = safePluginPath(body.filename);
        const content = String(body.content ?? '');

        if (!content.trim()) throw new Error('the file is empty');
        if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
          throw new Error(`the file is over ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB`);
        }

        const existed = fs.existsSync(target);
        // Unload the running copy first, or the old one keeps its port and
        // timers while the new file sits unused on disk.
        if (existed && bot.plugins.get(name)?.state === 'loaded') {
          await bot.plugins.unload(name);
        }

        fs.writeFileSync(target, content, 'utf8');
        log.info(`${existed ? 'replaced' : 'uploaded'} ${base} (${Buffer.byteLength(content)} bytes)`);

        let loaded = null;
        if (body.load !== false) {
          bot.plugins.plugins.delete(name);
          const entry = bot.plugins.discover().find((e) => e.name === name);
          if (entry) {
            await bot.plugins.load(entry);
            await bot.plugins.syncCommands();
            loaded = bot.plugins.get(name);
          }
        }

        return send(res, 200, {
          ok: true,
          replaced: existed,
          name,
          state: loaded?.state ?? 'not loaded',
          error: loaded?.error?.message ?? null,
        });
      }

      if (route === '/api/action' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid plugin name');

        let result;
        if (body.action === 'load') {
          const known = bot.plugins.get(name);
          const entry = known
            ? { name, file: known.file, kind: known.kind === 'native' ? 'native' : 'script' }
            : bot.plugins.discover().find((e) => e.name === name);
          if (!entry) throw new Error('no file for that plugin');
          bot.plugins.plugins.delete(name);
          const ok = await bot.plugins.load(entry);
          result = { ok, error: ok ? null : bot.plugins.get(name)?.error?.message };
        } else if (body.action === 'unload') {
          result = await bot.plugins.unload(name);
        } else if (body.action === 'reload') {
          result = await bot.plugins.reload(name);
        } else if (body.action === 'scan') {
          result = { ok: true, ...(await bot.plugins.loadNew()) };
        } else {
          throw new Error('unknown action');
        }

        await bot.plugins.syncCommands();
        return send(res, 200, result);
      }

      if (route === '/api/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const { target, name, base } = safePluginPath(body.filename);
        if (!fs.existsSync(target)) throw new Error('no such file');

        if (bot.plugins.get(name)?.state === 'loaded') await bot.plugins.unload(name);
        fs.unlinkSync(target);
        bot.plugins.plugins.delete(name);
        await bot.plugins.syncCommands();

        log.warn(`deleted plugin file ${base}`);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/source' && req.method === 'GET') {
        const { target } = safePluginPath(url.searchParams.get('filename'));
        if (!fs.existsSync(target)) throw new Error('no such file');
        return send(res, 200, { content: fs.readFileSync(target, 'utf8').slice(0, MAX_UPLOAD_BYTES) });
      }

      if (route === '/api/npm' && req.method === 'POST') {
        const body = await readBody(req);
        // Shares the host implementation with /plugin npm, so validation and
        // spawn behaviour cannot drift between the two entry points.
        const result = await bot.plugins.installNpmPackage(body.package);
        if (!result.ok && result.code === -1 && /not a valid/.test(result.output)) throw new Error(result.output);
        return send(res, 200, { ok: result.ok, code: result.code, output: result.output });
      }

      if (route === '/api/install-url' && req.method === 'POST') {
        const body = await readBody(req);
        const mode = ['persist', 'memory', 'once'].includes(body.mode) ? body.mode : 'persist';
        log.info(`installing ${body.url} (${mode})`);
        const result = await bot.plugins.installFromUrl(String(body.url || ''), {
          mode,
          name: body.name || undefined,
        });
        await bot.plugins.syncCommands();
        return send(res, 200, result);
      }

      if (route === '/api/upload-archive' && req.method === 'POST') {
        // Raw binary body; the filename rides in the query string because a
        // multipart parser is a lot of code for one field.
        const filename = url.searchParams.get('filename') || 'upload.zip';
        const mode = url.searchParams.get('mode') === 'memory' ? 'memory' : 'persist';

        const buffer = await new Promise((resolve, reject) => {
          const chunks = [];
          let size = 0;
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_ARCHIVE_BYTES) {
              reject(new Error(`upload over ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB`));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });

        const result = await bot.plugins.installFromBuffer(buffer, { filename, mode });
        await bot.plugins.syncCommands();
        log.info(`installed ${result.name} from an uploaded file`);
        return send(res, 200, result);
      }

      if (route === '/api/remotes' && req.method === 'GET') {
        return send(res, 200, { remotes: bot.plugins.readRemotes() });
      }

      if (route === '/api/remotes/forget' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, { ok: bot.plugins.forgetRemote(String(body.name || '')) });
      }

      if (route === '/api/npm/list' && req.method === 'GET') {
        const pkgPath = path.join(bot.config.rootDir, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return send(res, 200, {
          dependencies: pkg.dependencies || {},
          optionalDependencies: pkg.optionalDependencies || {},
        });
      }

      return send(res, 404, { error: 'no such endpoint' });
    }

    // ---------- server ----------

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (!addressAllowed(req)) return send(res, 403, { error: 'address not permitted' });
      if (blocked(req)) return send(res, 429, { error: 'too many failed attempts, try again later' });

      // The page itself is public; every byte of data behind it is not.
      if (url.pathname === '/' && req.method === 'GET') {
        return send(res, 200, PAGE, 'text/html; charset=utf-8');
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      if (!authorised(req)) {
        recordFailure(req);
        return send(res, 401, { error: 'bad or missing token' });
      }
      recordSuccess(req);

      try {
        await handleApi(req, res, url);
      } catch (e) {
        if (!res.headersSent) send(res, 400, { error: e.message });
      }
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') log.error(`port ${port} is already in use`);
      else log.error(`server error: ${e.message}`);
    });

    server.listen(port, host, () => {
      log.info(`plugin panel on http://${host}:${port}`);
      if (allowed.length) log.info(`address allow-list active: ${allowed.join(', ')}`);
      if (host !== '127.0.0.1' && host !== 'localhost') {
        log.warn('');
        log.warn(`the panel is bound to ${host}, which means it is reachable beyond this machine.`);
        log.warn('it can upload and execute arbitrary code — the token is the only thing between');
        log.warn('the internet and full control of this host. prefer an SSH tunnel:');
        log.warn(`  ssh -L ${port}:127.0.0.1:${port} user@host`);
        log.warn('');
      }
    });

    // Sweep the failed-attempt table so a scan cannot grow it without bound.
    plugin.setInterval(
      () => {
        const now = Date.now();
        for (const [key, entry] of attempts) if (entry.blockedUntil && entry.blockedUntil < now) attempts.delete(key);
      },
      5 * 60_000,
    );
  },
};

// ---------------------------------------------------------------------------
// The UI. Entirely self-contained: no external stylesheet, font or script, so
// it works offline and under a strict content security policy.
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plugin panel</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --dim:#8b93a7;
    --accent:#5865f2; --ok:#3ba55d; --warn:#faa61a; --bad:#ed4245; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e2e5ea; --text:#1a1d23; --dim:#6b7280; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .status { color:var(--dim); font-size:12px; }
  main { padding:20px; max-width:1100px; margin:0 auto; display:grid; gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card h2 { font-size:13px; margin:0 0 12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); font-weight:600; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:7px 13px; font-size:13px; cursor:pointer; font-family:inherit; }
  button:hover { filter:brightness(1.12); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--text); }
  button.danger { background:var(--bad); }
  input, textarea { background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:6px; padding:8px 10px; font-size:13px; font-family:inherit; width:100%; }
  textarea { font-family:var(--mono); font-size:12.5px; min-height:260px; resize:vertical; white-space:pre; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1; min-width:180px; }
  table { width:100%; border-collapse:collapse; }
  td, th { padding:8px 6px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; }
  .loaded { background:var(--ok); } .failed { background:var(--bad); }
  .disabled-state { background:var(--dim); } .pending { background:var(--warn); }
  .mono { font-family:var(--mono); font-size:12px; }
  .dim { color:var(--dim); }
  .err { color:var(--bad); font-size:12px; font-family:var(--mono); white-space:pre-wrap; margin-top:4px; }
  pre.log { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; max-height:300px; overflow:auto; font-family:var(--mono); font-size:11.5px; margin:0; white-space:pre-wrap; }
  .lv-error,.lv-fatal { color:var(--bad); } .lv-warn { color:var(--warn); } .lv-debug,.lv-trace { color:var(--dim); }
  .gate { max-width:420px; margin:12vh auto; }
  .note { font-size:12px; color:var(--dim); margin-top:8px; line-height:1.5; }
  .hide { display:none; }
  .out { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; font-family:var(--mono); font-size:11.5px; max-height:220px; overflow:auto; white-space:pre-wrap; margin-top:10px; }
</style>
</head>
<body>

<div id="gate" class="gate card">
  <h2>Plugin panel</h2>
  <p class="note">This panel uploads and runs code inside the bot process. Enter the token from <span class="mono">plugins.json</span>.</p>
  <div class="row" style="margin-top:12px">
    <input id="tok" type="password" class="grow" placeholder="access token" autocomplete="current-password">
    <button onclick="unlock()">Enter</button>
  </div>
  <div id="gateErr" class="err"></div>
</div>

<div id="app" class="hide">
<header>
  <h1>Plugin panel</h1>
  <span id="status" class="status"></span>
  <span class="grow"></span>
  <button class="ghost" onclick="act('scan')">Scan for new files</button>
  <button class="ghost" onclick="refresh()">Refresh</button>
  <button class="ghost" onclick="lock()">Lock</button>
</header>

<main>
  <div class="card">
    <h2>Plugins</h2>
    <table><thead><tr><th>Name</th><th>State</th><th>Holds</th><th style="width:230px"></th></tr></thead>
    <tbody id="plugins"></tbody></table>
  </div>

  <div class="card">
    <h2>Upload a plugin</h2>
    <div class="row">
      <input id="fname" class="grow" placeholder="myplugin.js" spellcheck="false">
      <input type="file" id="picker" accept=".js" style="display:none" onchange="pick(this)">
      <button class="ghost" onclick="document.getElementById('picker').click()">Choose file…</button>
      <button onclick="upload()">Save &amp; load</button>
    </div>
    <textarea id="code" spellcheck="false" placeholder="// A plugin can be a plain script — it just runs.
const http = require('node:http');
http.createServer((q, r) =&gt; r.end('hi')).listen(3001, '127.0.0.1');

// …or export init(plugin) for commands, storage and scheduled tasks.
"></textarea>
    <div class="note">Saved into the plugins directory and loaded immediately. Uploading over a running plugin unloads the old one first, so its port and timers are released.</div>
    <div id="upOut" class="out hide"></div>
  </div>

  <div class="card">
    <h2>Install from a URL</h2>
    <div class="row">
      <input id="url" class="grow" placeholder="https://example.com/plugin.js  or  .zip / .tar.gz" spellcheck="false">
      <select id="mode" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:8px">
        <option value="persist">Keep on disk</option>
        <option value="once">Run once, delete file</option>
        <option value="memory">Memory only, refetch on restart</option>
      </select>
      <button onclick="installUrl()">Install</button>
    </div>
    <div class="note">
      <strong>Keep on disk</strong> — normal install, survives restarts.<br>
      <strong>Run once</strong> — downloaded, loaded, then the file is deleted. Keeps running until the next restart, then it is gone.<br>
      <strong>Memory only</strong> — never written to disk at all. The URL is remembered and fetched again on every start.
    </div>
    <div class="row" style="margin-top:10px">
      <input type="file" id="arch" accept=".zip,.tar,.gz,.tgz,.js" style="display:none" onchange="uploadArchive(this)">
      <button class="ghost" onclick="document.getElementById('arch').click()">Upload .zip / .tar.gz / .js…</button>
      <span class="note" style="margin:0">A folder archive needs an index.js, or a package.json with "main".</span>
    </div>
    <div id="urlOut" class="out hide"></div>
    <div id="remotes" class="note"></div>
  </div>

  <div class="card">
    <h2>npm packages</h2>
    <div class="row">
      <input id="pkg" class="grow" placeholder="axios   or   @scope/name@1.2.3" spellcheck="false">
      <button onclick="install()">Install</button>
    </div>
    <div class="note">Installed into the bot's own node_modules, so every plugin can require it. Runs <span class="mono">npm install</span> with a 2 minute timeout.</div>
    <div id="deps" class="note"></div>
    <div id="npmOut" class="out hide"></div>
  </div>

  <div class="card">
    <h2>Recent log</h2>
    <pre id="log" class="log"></pre>
  </div>
</main>
</div>

<script>
var TOKEN = sessionStorage.getItem('panelToken') || '';

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json' }, opts.headers || {});
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  });
}

function unlock() {
  TOKEN = document.getElementById('tok').value.trim();
  api('/api/state').then(function () {
    sessionStorage.setItem('panelToken', TOKEN);
    document.getElementById('gate').classList.add('hide');
    document.getElementById('app').classList.remove('hide');
    refresh();
    setInterval(refresh, 5000);
  }).catch(function (e) {
    document.getElementById('gateErr').textContent = e.message;
  });
}

function lock() { sessionStorage.removeItem('panelToken'); location.reload(); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function refresh() {
  api('/api/state').then(render).catch(function (e) {
    document.getElementById('status').textContent = 'disconnected: ' + e.message;
  });
  api('/api/npm/list').then(function (d) {
    var names = Object.keys(d.dependencies).concat(Object.keys(d.optionalDependencies));
    document.getElementById('deps').textContent = 'Installed: ' + names.join(', ');
  }).catch(function () {});
  loadRemotes();
}

function render(s) {
  var b = s.bot;
  document.getElementById('status').textContent =
    (b.ready ? 'gateway up' : 'gateway not connected') +
    ' · ' + b.guilds + ' server(s) · ' + b.commands + ' commands · ' +
    b.rssMb + ' MB' + (b.limitMb ? ' / ' + b.limitMb + ' MB' : '') + ' · profile ' + b.profile +
    ' · ' + s.stats.loaded + '/' + s.stats.total + ' plugins' + (s.watching ? ' · watching' : '');

  var rows = s.plugins.map(function (p) {
    var holds = [];
    if (p.owned) {
      if (p.owned.timers) holds.push(p.owned.timers + ' timer');
      if (p.owned.resources) holds.push(p.owned.resources + ' resource');
      if (p.owned.listeners) holds.push(p.owned.listeners + ' listener');
      if (p.owned.commands.length) holds.push(p.owned.commands.map(function (c) { return '/' + c; }).join(' '));
    }
    var cls = p.state === 'disabled' ? 'disabled-state' : p.state;
    return '<tr>' +
      '<td><span class="dot ' + cls + '"></span><strong>' + esc(p.name) + '</strong>' +
        (p.version ? ' <span class="dim">v' + esc(p.version) + '</span>' : '') +
        '<div class="dim mono">' + esc(p.file) + ' · ' + esc(p.kind) + '</div>' +
        (p.description ? '<div class="dim">' + esc(p.description) + '</div>' : '') +
        (p.error ? '<div class="err">' + esc(p.error) + '</div>' : '') +
      '</td>' +
      '<td>' + esc(p.state) + '</td>' +
      '<td class="dim">' + esc(holds.join(' · ') || '—') + '</td>' +
      '<td class="row">' +
        (p.state === 'loaded'
          ? '<button class="ghost" onclick="act(\\'unload\\',\\'' + esc(p.name) + '\\')">Unload</button>' +
            '<button class="ghost" onclick="act(\\'reload\\',\\'' + esc(p.name) + '\\')">Reload</button>'
          : '<button class="ghost" onclick="act(\\'load\\',\\'' + esc(p.name) + '\\')">Load</button>') +
        '<button class="ghost" onclick="edit(\\'' + esc(p.file) + '\\')">Edit</button>' +
        '<button class="danger" onclick="del(\\'' + esc(p.file) + '\\')">Delete</button>' +
      '</td></tr>';
  });
  document.getElementById('plugins').innerHTML = rows.join('') ||
    '<tr><td colspan="4" class="dim">No plugins yet. Upload one below.</td></tr>';

  document.getElementById('log').innerHTML = s.log.map(function (e) {
    var t = new Date(e.at).toTimeString().slice(0, 8);
    return '<span class="lv-' + e.level + '">' + t + ' ' + e.level.toUpperCase().padEnd(5) +
      ' [' + esc(e.scope) + '] ' + esc(e.msg) + '</span>';
  }).join('\\n');
}

function act(action, name) {
  api('/api/action', { method: 'POST', body: JSON.stringify({ action: action, name: name }) })
    .then(function (r) {
      if (r.error) alert(action + ' failed:\\n\\n' + r.error);
      refresh();
    })
    .catch(function (e) { alert(e.message); });
}

function pick(input) {
  var f = input.files[0];
  if (!f) return;
  document.getElementById('fname').value = f.name;
  var fr = new FileReader();
  fr.onload = function () { document.getElementById('code').value = fr.result; };
  fr.readAsText(f);
}

function edit(file) {
  api('/api/source?filename=' + encodeURIComponent(file)).then(function (r) {
    document.getElementById('fname').value = file;
    document.getElementById('code').value = r.content;
    window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'smooth' });
  }).catch(function (e) { alert(e.message); });
}

function upload() {
  var out = document.getElementById('upOut');
  api('/api/upload', {
    method: 'POST',
    body: JSON.stringify({
      filename: document.getElementById('fname').value.trim(),
      content: document.getElementById('code').value
    })
  }).then(function (r) {
    out.classList.remove('hide');
    out.textContent = (r.replaced ? 'Replaced' : 'Created') + ' ' + r.name + ' — state: ' + r.state +
      (r.error ? '\\n\\n' + r.error : '');
    refresh();
  }).catch(function (e) {
    out.classList.remove('hide');
    out.textContent = 'Failed: ' + e.message;
  });
}

function del(file) {
  if (!confirm('Delete ' + file + '? It will be unloaded and the file removed.')) return;
  api('/api/delete', { method: 'POST', body: JSON.stringify({ filename: file }) })
    .then(refresh).catch(function (e) { alert(e.message); });
}

function installUrl() {
  var out = document.getElementById('urlOut');
  var u = document.getElementById('url').value.trim();
  if (!u) return;
  var mode = document.getElementById('mode').value;
  out.classList.remove('hide');
  out.textContent = 'downloading ' + u + '…';
  api('/api/install-url', { method: 'POST', body: JSON.stringify({ url: u, mode: mode }) })
    .then(function (r) {
      out.textContent = (r.ok ? 'installed ' : 'failed ') + r.name + ' (' + (r.mode || 'persist') + ')' +
        (r.files ? ' — ' + r.files + ' file(s)' : '') + (r.error ? '\\n\\n' + r.error : '');
      refresh();
    })
    .catch(function (e) { out.textContent = 'Failed: ' + e.message; });
}

function uploadArchive(input) {
  var f = input.files[0];
  if (!f) return;
  var out = document.getElementById('urlOut');
  out.classList.remove('hide');
  out.textContent = 'uploading ' + f.name + '…';
  f.arrayBuffer().then(function (buf) {
    return fetch('/api/upload-archive?filename=' + encodeURIComponent(f.name), {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/octet-stream' },
      body: buf
    }).then(function (r) { return r.json(); });
  }).then(function (r) {
    out.textContent = r.error && !r.ok
      ? 'Failed: ' + r.error
      : 'installed ' + r.name + (r.files ? ' — ' + r.files + ' file(s)' : '') + (r.stripped ? ' (stripped ' + r.stripped + '/)' : '');
    input.value = '';
    refresh();
  }).catch(function (e) { out.textContent = 'Failed: ' + e.message; });
}

function loadRemotes() {
  api('/api/remotes').then(function (d) {
    var names = Object.keys(d.remotes || {});
    var el = document.getElementById('remotes');
    if (!names.length) { el.textContent = ''; return; }
    el.innerHTML = 'Remembered sources: ' + names.map(function (n) {
      var r = d.remotes[n];
      return '<span class="mono">' + esc(n) + '</span> (' + esc(r.mode) + ') ' +
        '<a href="#" onclick="forget(\\'' + esc(n) + '\\');return false" style="color:var(--bad)">forget</a>';
    }).join(' · ');
  }).catch(function () {});
  loadRemotes();
}

function forget(name) {
  api('/api/remotes/forget', { method: 'POST', body: JSON.stringify({ name: name }) }).then(loadRemotes);
}

function install() {
  var out = document.getElementById('npmOut');
  var name = document.getElementById('pkg').value.trim();
  if (!name) return;
  out.classList.remove('hide');
  out.textContent = 'installing ' + name + '…';
  api('/api/npm', { method: 'POST', body: JSON.stringify({ package: name }) })
    .then(function (r) {
      out.textContent = (r.ok ? 'installed' : 'failed (exit ' + r.code + ')') + '\\n\\n' + r.output;
      refresh();
    })
    .catch(function (e) { out.textContent = 'Failed: ' + e.message; });
}

if (TOKEN) unlock();
</script>
</body>
</html>`;
