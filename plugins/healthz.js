/**
 * healthz — a health endpoint for platforms that insist on one.
 *
 * Binds nothing unless a port was asked for. A Discord bot has no reason to
 * serve one, and a port on a fresh install is a port nobody asked for - so this
 * loads everywhere and acts only where PORT (or HEALTHZ_PORT) is set, which on
 * a PaaS is exactly the signal that the platform wants a listener.
 *
 * `PLUGINS_IGNORED=healthz` removes it entirely.
 *
 * ── What it actually checks ────────────────────────────────────────────────
 *
 * "The process is alive" is answered by the TCP connection succeeding, and is
 * nearly worthless: a bot whose gateway died an hour ago still accepts
 * connections. So the status code reflects whether the bot is *doing its job*:
 *
 *   200  the gateway is connected and the process is responsive
 *   503  still starting, or the gateway has been down past the grace period,
 *        or the event loop is stalling badly enough to miss interactions
 *
 * 503 during startup is deliberate: a platform that waits for healthy before
 * routing should wait, and one that restarts on repeated failure should not
 * restart a bot that is three seconds from being ready - hence the grace.
 *
 * ── What it deliberately does not expose ───────────────────────────────────
 *
 * On a PaaS this is on the service's public URL with no credential in front of
 * it, so the body carries no server names, no user ids, no counts of anything
 * that identifies who this bot serves. Status, timings and memory only.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 *
 * Environment, or `config.healthz` in plugins.json:
 *
 *   PORT                 the platform's port. Bound on 0.0.0.0 when set.
 *   HEALTHZ_PORT         override, for running it somewhere else
 *   HEALTHZ_HOST         override the bind address
 *   HEALTHZ_GATEWAY_GRACE_MS   how long a disconnected gateway stays "ok"
 *                              (default 120000) - short enough to recover a
 *                              wedged shard, long enough to ride out a
 *                              Discord hiccup without a restart loop
 *   HEALTHZ_MAX_LAG_MS   event-loop stall that counts as unhealthy (default
 *                        3000, which is Discord's interaction deadline)
 *
 * ── A note on TCP checks ───────────────────────────────────────────────────
 *
 * If the platform's check is `type: tcp` it only opens a socket and closes it:
 * the status code is never read, so every check above is decorative and any
 * listener would do. Point an HTTP check at `/healthz` to get the real answer.
 */

'use strict';

const http = require('node:http');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const config = typeof plugin !== 'undefined' ? plugin.config || {} : {};
const bot = typeof plugin !== 'undefined' ? plugin.bot : null;
const log = typeof plugin !== 'undefined' ? plugin.log : console;

// Nothing to do unless a port was asked for. A Discord bot needs no inbound
// port, so this plugin exists only for hosts that inject PORT and restart the
// deployment when nothing listens on it - and that injection is the signal.
// On a laptop, or a VPS, or a panel that injects nothing, this file loads and
// then does nothing at all, which is why it no longer has to ship disabled.
const asked = config.port || process.env.HEALTHZ_PORT || process.env.PORT;
const PORT = num(asked, 3000);

// 0.0.0.0 when the platform supplied the port, because the checker is outside
// this container. Otherwise localhost, so a laptop does not quietly expose it.
const HOST = config.host || process.env.HEALTHZ_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const GATEWAY_GRACE_MS = num(config.gatewayGraceMs || process.env.HEALTHZ_GATEWAY_GRACE_MS, 120_000);
const MAX_LAG_MS = num(config.maxLagMs || process.env.HEALTHZ_MAX_LAG_MS, 3000);

/** When the gateway was last seen up, so a drop can be timed rather than guessed. */
let lastConnected = 0;

if (bot?.client) {
  plugin.onDiscord('clientReady', () => {
    lastConnected = Date.now();
  });
  plugin.onDiscord('shardResume', () => {
    lastConnected = Date.now();
  });
  plugin.onDiscord('shardReady', () => {
    lastConnected = Date.now();
  });
}

/**
 * The actual assessment. Returns the checks separately so the body can say
 * which one failed rather than only that something did.
 */
function assess() {
  const client = bot?.client;
  const ready = Boolean(bot?.readyAt);

  // discord.js exposes 0 for READY; anything else is some stage of not being
  // connected. Treated as a string here so a version change cannot silently
  // turn "unknown" into "fine".
  const wsStatus = client?.ws?.status;
  const connected = ready && wsStatus === 0;

  if (connected) lastConnected = Date.now();
  const downForMs = connected ? 0 : lastConnected ? Date.now() - lastConnected : 0;

  const checks = {
    // Never been ready: starting up, not broken.
    started: {
      ok: ready,
      detail: ready ? 'gateway has connected' : 'waiting for the first gateway connection',
    },
    gateway: {
      ok: connected || downForMs < GATEWAY_GRACE_MS,
      detail: connected
        ? 'connected'
        : `disconnected for ${Math.round(downForMs / 1000)}s (grace ${Math.round(GATEWAY_GRACE_MS / 1000)}s)`,
    },
    eventLoop: {
      ok: (bot?.lagPeak ?? 0) < MAX_LAG_MS,
      detail: `worst stall ${bot?.lagPeak ?? 0}ms of ${MAX_LAG_MS}ms allowed`,
    },
  };

  const failing = Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name);
  return { ready, connected, checks, failing };
}

function body(result) {
  const mem = process.memoryUsage();
  return {
    status: result.failing.length === 0 ? 'ok' : result.ready ? 'degraded' : 'starting',
    // No guild names, no ids, no member counts: this is a public URL.
    uptimeMs: bot?.readyAt ? Date.now() - bot.readyAt : 0,
    gatewayPingMs: bot?.client?.ws?.ping >= 0 ? Math.round(bot.client.ws.ping) : null,
    rssMb: Math.round(mem.rss / 1048576),
    // What the kernel charges the whole container, where that is readable.
    // Larger than rss whenever anything else in the container uses memory -
    // another process, or /tmp when it is a tmpfs.
    containerMb: bot?.containerUsedMb ?? null,
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    checks: result.checks,
  };
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path !== '/' && path !== '/healthz' && path !== '/health') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const result = assess();
  const payload = JSON.stringify(body(result));

  res.writeHead(result.failing.length === 0 ? 200 : 503, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Nothing here is meant to be embedded anywhere.
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`port ${PORT} is already in use, so the health endpoint did not start`);
  } else {
    log.error(`health endpoint error: ${e.message}`);
  }
});

// createServer is tracked by the plugin host, so unloading releases the port.
if (asked) {
  server.listen(PORT, HOST, () => {
    log.info(`health endpoint on http://${HOST}:${PORT}/healthz`);
  });
}
