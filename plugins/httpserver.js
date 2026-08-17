/**
 * httpserver — a status endpoint for the bot.
 *
 * This is a *standalone script* plugin. There is no init() and nothing is
 * exported: the file simply runs when the bot loads it, exactly as if you had
 * typed `node plugins/httpserver.js`. Dropping a file like this into plugins/
 * and restarting (or running /plugin scan) is all it takes.
 *
 * It also still works as a plain script outside the bot:
 *
 *     node plugins/httpserver.js
 *
 * which is what the `typeof plugin` checks below are for. A plugin does not
 * have to do that - it is here to show that the host adds capabilities rather
 * than taking any away.
 *
 * Two things happen automatically when this runs inside the bot:
 *
 *   - `require('node:http').createServer()` returns a server the host is
 *     tracking, so `/plugin unload httpserver` closes the port. No cleanup
 *     code needed.
 *   - `setInterval` below is tracked the same way and stops on unload.
 *
 * Configure it in plugins/plugins.json:
 *
 *     { "config": { "httpserver": { "port": 3000, "host": "0.0.0.0" } } }
 */

'use strict';

const http = require('node:http');

// `plugin` is a free variable the host injects. Outside the bot it does not
// exist, so everything below has a fallback.
const inBot = typeof plugin !== 'undefined';
const log = inBot ? plugin.log : console;
const config = inBot ? plugin.config : {};

const PORT = Number(config.port || process.env.PORT || 3000);

// Binding rule, in priority order:
//   1. an explicit host in plugins.json always wins
//   2. if the platform injected PORT, it is a PaaS (Railway, Render, Fly,
//      Koyeb, Heroku…) whose health check comes from outside the container.
//      Binding to localhost there means the check never connects and the
//      deployment is killed as unhealthy, so bind to all interfaces.
//   3. otherwise localhost only - a status endpoint reachable from the whole
//      internet is rarely what someone wants by accident.
const HOST = config.host || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const startedAt = Date.now();
let requests = 0;

/** Everything the endpoint reports. Reads live bot state when available. */
function snapshot() {
  const base = {
    ok: true,
    service: 'discord-bot',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestsServed: requests,
    node: process.version,
    memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    pid: process.pid,
  };

  if (!inBot) return { ...base, mode: 'standalone' };

  const bot = plugin.bot;
  const s = bot.snapshot();
  return {
    ...base,
    mode: 'plugin',
    ready: Boolean(bot.readyAt),
    botUptimeSeconds: Math.floor(s.uptimeMs / 1000),
    guilds: s.guilds,
    users: s.users,
    gatewayPingMs: s.ping,
    commands: s.registry.commands,
    pendingTasks: s.scheduler.pending,
    commandsRun: s.counters.commands,
    errors: s.counters.errors,
    intents: s.intents,
    plugins: s.plugins,
  };
}

const server = http.createServer((req, res) => {
  requests++;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // A status endpoint is a fine thing to expose; anything that could change
  // state is deliberately not routed here.
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
    res.end(JSON.stringify({ ok: false, error: 'only GET is supported' }));
    return;
  }

  switch (url.pathname) {
    case '/':
    case '/status':
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot(), null, 2));
      return;

    case '/health': {
      // Deliberately cheap and boolean, so a monitor can poll it often.
      const healthy = !inBot || Boolean(plugin.bot.readyAt);
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(healthy ? 'ok' : 'not ready');
      return;
    }

    case '/metrics': {
      // Prometheus text format, so this drops straight into an existing scrape.
      const s = snapshot();
      const lines = [
        '# HELP discordbot_up 1 when the gateway is connected',
        '# TYPE discordbot_up gauge',
        `discordbot_up ${s.ready ? 1 : 0}`,
        '# HELP discordbot_guilds Number of servers',
        '# TYPE discordbot_guilds gauge',
        `discordbot_guilds ${s.guilds || 0}`,
        '# HELP discordbot_commands_total Commands executed since start',
        '# TYPE discordbot_commands_total counter',
        `discordbot_commands_total ${s.commandsRun || 0}`,
        '# HELP discordbot_errors_total Errors since start',
        '# TYPE discordbot_errors_total counter',
        `discordbot_errors_total ${s.errors || 0}`,
        '# HELP discordbot_memory_mb Resident memory in megabytes',
        '# TYPE discordbot_memory_mb gauge',
        `discordbot_memory_mb ${s.memoryMb}`,
        '# HELP discordbot_gateway_ping_ms Gateway heartbeat latency',
        '# TYPE discordbot_gateway_ping_ms gauge',
        `discordbot_gateway_ping_ms ${s.gatewayPingMs || 0}`,
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(`${lines.join('\n')}\n`);
      return;
    }

    default:
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found', routes: ['/status', '/health', '/metrics'] }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`port ${PORT} is already in use — set a different one in plugins/plugins.json`);
  } else {
    log.error(`http server error: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  log.info(`status endpoint listening on http://${HOST}:${PORT} (/status, /health, /metrics)`);
  if (HOST === '0.0.0.0' && !config.host) {
    log.info('bound to all interfaces because PORT was set by the platform — this is what its health check needs');
  }
});

// Tracked automatically, so it stops when the plugin is unloaded.
setInterval(() => {
  log.debug(`served ${requests} request(s) so far`);
}, 60 * 60 * 1000);
