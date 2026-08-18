# Discord Bot

A modular Discord bot: moderation with a case log, automod, levelling, an
economy, ten interactive games, tickets, giveaways, a starboard, reaction roles
and server automation.

**74 slash commands, one runtime dependency (`discord.js`), no database server.**

```bash
npm install
node index.js
```

The first run prompts for a bot token and offers to save it to `.env`. On a
hosting panel, set `DISCORD_TOKEN` as a startup variable instead.

---

## Minimum configuration

`.env.example` lists 44 environment variables. **You need one**, on a 256 MB
host as much as on a large one. Everything else has a working default, and all
per-server behaviour is configured inside Discord with `/config` — not with
environment variables.

| Host | What to set |
|---|---|
| Anything with ≥ 1 GB | `DISCORD_TOKEN` |
| **256–512 MB** | `DISCORD_TOKEN` |

```bash
cp deploy/env.256mb.example .env    # a ready-made 256 MB config; paste your token
```

Yes, the token really is all of it, on a 256 MB host too. The two things that
otherwise need tuning there — the discord.js caches and the V8 heap — are both
sized from the cgroup limit at boot. `MEMORY_PROFILE` overrides the first if the
platform exposes no limit to read; the second is covered under *Heap sizing*.

Two more worth knowing about, neither required:

- `GUILD_ID` — pins command registration to one server. Usually unnecessary: with
  it unset and the bot in five servers or fewer, each is registered directly, so
  commands appear immediately rather than taking Discord up to an hour.
- `OWNER_IDS` — usually unnecessary: the application owner is fetched from
  Discord at startup, so whoever created the bot can already use `/owner` and
  `/plugin`. Set this only to grant them to someone else.

The remaining ~38 are operational knobs (cache and log tuning, feature switches,
embed colours). They exist for the cases that need them; ignore them otherwise.

---

## Layout

Entry point is `index.js`. Everything else lives under `src/`.

```
index.js                 boot, token resolution, intent-fallback login, graceful shutdown
src/bot.js               the hub: owns every subsystem, passed to all code

src/core/
  config.js              environment configuration, read once
  logger.js              levelled stdout logger with a ring buffer for /stats
  store.js               crash-safe JSON store (atomic writes, debounce, backups)
  db.js                  guild settings schema, member records, case log
  scheduler.js           persistent timed tasks that survive restarts
  registry.js            command loader/validator + component router
  cooldowns.js           per-command cooldowns and a burst guard
  context.js             the object every command receives
  i18n.js                English and 简体中文 strings

  plugins.js             plugin host: load, run, unload, hot-reload
  archive.js             zip and tar.gz readers for plugin bundles

src/util/                time, text, random, embeds, perms, pager, components, mathexpr
src/data/                trivia bank, word lists, shop items, job flavour, colours, codecs
src/features/            18 features (automod, economy, leveling, tickets, …)
src/games/               10 games + the session manager
src/events/              gateway event handlers
src/commands/            slash commands, grouped by category

plugins/                 drop .js files here — see plugins/README.md
test/                    74 tests: pure logic, plugins, runtime limits, gateway resilience
```

Run the tests with `npm test` (Node's built-in runner, no dev dependencies).

---

## What it does

| Area | Commands |
|---|---|
| **Moderation** | `/kick` `/ban` `/softban` `/unban` `/timeout` `/untimeout` `/warn` `/purge` `/lock` `/unlock` `/slowmode` `/nick` `/role` `/case` `/note` `/modstats` |
| **Automod** | `/automod` — 12 rules (invites, links, mentions, caps, spam, duplicates, word filter, emoji, zalgo, attachments, new accounts, walls) with per-rule actions and strike escalation |
| **Levelling** | `/rank` `/profile` `/xp` `/leaderboard` — message and voice XP, role rewards, multipliers |
| **Economy** | `/balance` `/daily` `/weekly` `/work` `/crime` `/rob` `/pay` `/bank` `/shop` `/buy` `/sell` `/inventory` `/use` |
| **Games** | `/game` — tic-tac-toe, Connect Four, hangman, Wordle, minesweeper, blackjack, slots, trivia, rock-paper-scissors, guess-the-number |
| **Utility** | `/help` `/ping` `/botinfo` `/stats` `/avatar` `/userinfo` `/serverinfo` `/roleinfo` `/channelinfo` `/emoji` `/math` `/encode` `/decode` `/color` `/timestamp` `/poll` `/remind` `/afk` `/todo` `/birthday` `/snipe` `/tag` `/say` |
| **Fun** | `/roll` `/pick` `/8ball` `/fun` `/ship` |
| **Server features** | `/giveaway` `/ticket` `/reactionrole` `/starboard` `/autoresponder` `/suggest` `/suggestion` |
| **Setup** | `/config` — 12 groups covering every per-server setting |
| **Operator** | `/owner` — status, guild list, blacklist, log level, backups, task queue<br>`/plugin` — upload, install from URL, npm install, list, load, unload, reload, delete, source, scan, watch |

Everything is **off by default**. A freshly invited bot stays silent until an
admin runs `/config`.

---

## Plugins

Drop a `.js` file into `plugins/` and it loads. It can be a plain standalone
script — no exports, no contract — or export `init(plugin)` for slash commands,
buttons, gateway listeners, scheduled tasks and persistent storage.

The two bundled plugins are **examples and ship disabled**, so a fresh install
opens no port and adds no commands. Enable one with `/plugin load` or by editing
`plugins/plugins.json`.

```js
// plugins/ticker.js — a complete, working plugin
setInterval(() => console.log('tick'), 60_000);
```

Timers and servers a plugin creates are tracked and released when it unloads, so
a plugin that opens a port needs no cleanup code. Install from a file, a URL or a
`.zip`, and manage it all from Discord with `/plugin` — no port and no separate
credential, since the owner-only check is the authentication.

**Plugins run with the bot's full privileges**, so installing one is as
consequential as editing the bot's source. Set `PLUGINS_ENABLED=false` where that
is not acceptable.

📖 **Everything else is in [`plugins/README.md`](plugins/README.md)** — the
context API, dependency handling, persistence modes and native addons.

---

## Resource usage

Measured in a hard 256 MB / 1-core incus container (Ubuntu 24.04, arm64,
Node 18.19), full command set plus both example plugins, idle:

| | |
|---|---|
| Resident memory | **76 MB** (69 MB with `--max-old-space-size=140`) |
| Container total (cgroup) | **71 MB of 256 MB — 28%** |
| Idle CPU | **0.02%**, peak 0.5% |
| Boot time | **215 ms** |
| Node + discord.js baseline | 73 MB of the above |
| This bot's own code | ~3 MB (74 commands, 19 features, 10 games) |

Idle CPU is genuinely near zero: no polling loops, and every internal timer is
`unref`'d. Work happens on gateway events and one scheduler tick every 5 s.

### On a 256 MB host

Memory is dominated by discord.js, not by this bot, and it grows with what
discord.js *caches* once guilds connect. Its defaults cache 200 messages **per
channel** forever and never evict a user, member or voice state — which is the
usual reason a bot slowly eats a small VPS.

So the client is built from a **memory profile** that caps every cache and turns
on sweepers. The profile is auto-selected by reading the **cgroup limit** first,
falling back to host RAM — a 256 MB container on a big host correctly picks
`low` rather than planning for the host's memory:

| Profile | Chosen when | Message cache | Sweeps |
|---|---|---|---|
| `low` | ≤ 512 MB | 25/channel | messages 10 min, members/users 15 min |
| `balanced` | ≤ 2 GB | 100/channel | messages 30 min, members/users 1 h |
| `high` | > 2 GB | 400/channel | messages 2 h |

Override with `MEMORY_PROFILE=low|balanced|high`. `low` trades away message
delete/edit logging for messages older than ~10 minutes, which is stated in the
log at boot rather than left to be discovered.

**Also set the V8 heap ceiling.** V8 sizes its heap from *host* memory, so in a
256 MB container it plans for gigabytes, never feels pressure, and gets
OOM-killed with no stack trace. The bot detects this and prints the exact flag:

```bash
node --max-old-space-size=140 index.js
```

### Nothing grows without bound

Every store has a ceiling, enforced either at write time or by a housekeeping
pass that runs every 6–24 h (profile-dependent):

| Data | Bound |
|---|---|
| Log ring buffer (for `/stats logs`) | 500 lines |
| Log file (optional, `LOG_FILE`) | `LOG_FILE_MAX_BYTES` × (`LOG_FILE_KEEP` + 1), ~5 MB default |
| Moderation cases | 5,000 per guild |
| Snipe buffer | 5 per channel, 30 min, memory only |
| Game sessions | 500, 20 min idle |
| Tags | 200 per guild |
| Closed polls | pruned after 30 days |
| Resolved suggestions | pruned after 90 days |
| Starboard mappings | pruned after 120 days |
| Member records | empty ones pruned; on `low`, idle+valueless ones after 90 days |
| Finished giveaways | pruned after 7 days |
| Cooldowns, automod counters, paginators | swept on a timer |

Member records are created on *read* — a leaderboard render touches every
member — so the pass drops rows that hold nothing. `/stats memory` shows live
cache sizes, stored record counts and the last pass's results.

A **watchdog** logs a warning at 80% of the memory limit and runs housekeeping
early at 92%, so you hear about it before the OOM killer does.

### Logging

All output goes to **stdout** (panels read stdout, and many discard stderr).
That is unbounded only if something else captures it — systemd's journal and
hosting panels rotate on their own. If nothing does, set `LOG_FILE` and the bot
writes a size-rotated file with a hard ceiling.

Plugin output goes through the same logger, tagged `[plugin:<name>]`, including
bare `console.log` inside a plugin. Plugins get no separate log file and cannot
grow the ring buffer beyond its cap.

---

## Design notes

A few decisions that are load-bearing, so they do not get undone by accident:

**A dead gateway ends the process, it does not linger.** Discord going away is
not a crash — the danger is the opposite. Without handlers for the connection
events the process stays alive with no gateway, does nothing, and never exits,
so no supervisor restarts it. Recoverable drops are logged and left to
discord.js to retry; an unrecoverable one (token reset, application deleted,
intent revoked) flushes state and exits non-zero so the supervisor takes over,
and the next start reports exactly which it was.

**Privileged intents degrade, they do not fail.** Login walks down a ladder of
intent sets. If `SERVER MEMBERS` or `MESSAGE CONTENT` is switched off in the
developer portal, the bot starts anyway and logs exactly which features that
costs and which checkbox restores them. A bot that refuses to boot over one
checkbox is the single most common self-hosting dead end.

**Timers are persistent.** Reminders, temporary bans, giveaway endings,
scheduled unlocks and delayed autoroles are rows in `data/tasks.json`, not
`setTimeout` calls. A panel restart costs nothing. Overdue tasks run on boot.

**Storage is crash-safe.** Writes go to a temp file and are renamed over the
target, so a crash mid-write cannot truncate a file. Writes are debounced, a
corrupt file is moved aside rather than deleted, and backups rotate.

**`/math` does not use `eval`.** It is a hand-written tokeniser and
recursive-descent parser (`src/util/mathexpr.js`) with a fixed function table
and a step budget. `eval` in a public chat command is arbitrary code execution
on the host.

**Buttons instead of reactions** for polls, giveaways and suggestions. Reaction
counts cannot tell you *who* voted without a paginated fetch, which makes vote
switching and "you already voted" impossible to implement correctly, and
silently truncates at large counts.

**Games use a session table, not collectors.** A collector dies with the process
and expires after 15 minutes, so a restart leaves dead buttons on every open
board. Sessions are looked up per click and expired buttons explain themselves.

**Moderation DMs the member before acting.** After a ban the bot can no longer
open a DM channel with them, so the order matters.

**Settings merge over defaults on read.** Adding a setting to `DEFAULT_GUILD` is
the whole change — no migration step, and stores written by older versions keep
working. Unknown keys are preserved rather than dropped.

**The prefix bridge is read-only.** Text commands cover information and
self-service only. Moderation over a text command has no permission scoping from
Discord's side, so the bot would have to reimplement it.

---

## Configuration

See [Minimum configuration](#minimum-configuration) above for the short answer,
and `.env.example` for all 44 variables with their defaults. They fall into
tiers:

| | Variables | When you need them |
|---|---|---|
| **Required** | `DISCORD_TOKEN` | always |
| **Small hosts** | `MEMORY_PROFILE` | only if the platform hides its memory limit |
| **Useful** | `GUILD_ID`, `OWNER_IDS`, `LOG_LEVEL`, `LOG_FILE`, `DATA_DIR` | setup, debugging, volumes |
| **Knobs** | `SAVE_INTERVAL`, `BACKUP_COUNT`, `SCHEDULER_TICK`, `REGISTER_COMMANDS`, `PLUGIN_*` | tuning, development |
| **Cosmetic** | `EMBED_COLOR*`, `ACTIVITY*`, `STATUS`, `PREFIX`, `BOT_LANG`, `WELCOME_CHANNEL` | rebranding; most are also per-server via `/config` |
| **Feature switches** | 11 × `FEATURE_*` | removing a whole feature globally |
| **Plugin-owned** | `PORT`, `WEBPANEL_TOKEN`, `WEBPANEL_PORT` | read by bundled plugins, not the bot |

The bottom four tiers are there for the deployments that need them. A normal
install touches none of them.

Per-server behaviour is configured in Discord:

```
/config general view          show everything currently set
/config welcome toggle        greetings, goodbye, autorole
/config logging channel       the audit log
/config leveling toggle       XP, rewards, voice XP
/config economy toggle        currency, payouts, drops
/config moderation threshold  automatic action at N warnings
/config commands disable      turn off a command, server-wide or per channel
```

---

## Deploying

### Requirements

| | |
|---|---|
| **Node** | **22.15 or newer.** Declared in `package.json` `engines`, `.nvmrc` and `.node-version`, so any host that reads one of those installs the right runtime by itself. |
| Dependencies | One (`discord.js`), plus `dotenv` if you use a `.env` file. |
| Database | None. |
| RAM | 256 MB is enough — see *Resource usage*. |

Node 18 and 20 still run the bot, and nothing is disabled on them. The reason
for the floor is that both lack `process.execve`, so on a memory-limited host
the bot has to run itself as a **child** process to cap the V8 heap, and that
supervisor costs ~45 MB of the budget. On 22.15+ the process replaces itself
instead: same pid, nothing extra resident. The boot log says which one happened.

**You do not pass any special command-line flags, and there is nothing to set
beyond the token.** The V8 heap used to be the exception; the bot now sizes it
from the container limit itself, so `NODE_OPTIONS` is no longer needed anywhere.
See *Heap sizing* under Troubleshooting for what it does and how to switch it
off.

### Docker (recommended on a small VPS)

```bash
echo "DISCORD_TOKEN=your_token" > .env
docker compose up -d
```

`docker-compose.yml` sets `mem_limit: 256m` and nothing else. The bot reads the
cgroup limit and selects its `low` cache profile on its own. Container logs are
capped at 3 × 5 MB. The healthcheck uses the bundled `httpserver` plugin.

### systemd

```bash
sudo cp deploy/discord-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-bot
journalctl -u discord-bot -f
```

Sets `MemoryMax=256M`, restart-on-failure and a hardened
sandbox. journald rotates the logs, so `LOG_FILE` is unnecessary.

### PaaS (Railway, Render, Fly.io, Koyeb, Dokploy, Coolify…)

Most of these detect the `Dockerfile` and build it with no further
configuration. Set `DISCORD_TOKEN` in their environment settings and it starts.

**A default install listens on no ports.** The bot core never opens one, and the
two bundled plugins are examples that ship disabled. It is a long-running worker
process, and a container whose main process keeps running is all any of these
platforms need.

If you enable the `httpserver` example, that changes — see the worker/web note
below.

**Choose the worker service type, not the web one.** That is the only thing to
get right:

| Platform | Pick this | Port needed? |
|---|---|---|
| Render | Background Worker | no |
| Railway | service without a public domain | no |
| Fly.io | omit `http_service` from `fly.toml` | no |
| Koyeb | Worker | no |
| Heroku | `worker` dyno | no |
| Dokploy / Coolify / plain Docker | any | no |

Only if you deliberately pick a **web** service type does the platform health-check
an HTTP port and mark the deployment unhealthy when nothing answers. In that case
enable the bundled `httpserver` plugin: when the platform injects `PORT` it binds
`0.0.0.0:$PORT` instead of localhost, and `/health` returns 503 until the gateway
connects — which is exactly what a health check should see during startup.

Two things that do matter on every platform:

**The filesystem is usually ephemeral, and often read-only.** `data/` holds every
server's settings, member records and moderation history. Without a persistent
volume it is wiped on every redeploy — the most common way to lose a server's
configuration. Mount one at `/app/data`.

If the filesystem is read-only with only `/tmp` writable, the bot checks at
startup and refuses to run rather than quietly writing somewhere that will not
survive. Either mount a volume, or set `DATA_DIR=/tmp/mulebot` to say explicitly
that you accept losing everything on restart. Plugin installs are treated
differently: they fall back to a scratch directory automatically, because that
code can be fetched again — and every install reports when it did so.

**The heap needs no setting.** It is sized from the cgroup limit at boot. If the
platform exposes no limit the bot can read, set `MEMORY_PROFILE=low` — the boot
log says which happened.

Scale to **one instance**. Two instances on the same token both connect to the
gateway and every command runs twice.

### Hosting panel (Pterodactyl / Pelican / FeatherPanel), 256 MB plan

Startup command, if the panel lets you set one:

```
if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; node index.js
```

No `NODE_OPTIONS` prefix is needed — the bot caps its own heap. Panels usually
pin an old Node and ignore `engines`, so pick the **Node 22** egg or image in the
panel if it offers one; on an older one everything still works, minus ~45 MB.

#### If the panel cannot set environment variables or the startup command

Plenty of cheap panels give you a file manager and nothing else. **Everything
except one setting can go in a `.env` file** next to `index.js` — upload it with
the file manager and restart. Real environment variables always win over `.env`,
so the same file works on a panel that does support them.

Copy `.env.example` to `.env` and edit, or create it with just:

```ini
DISCORD_TOKEN=your_token_here

# The important one on a 256 MB plan. Panels rarely expose a cgroup limit the
# bot can read, so tell it directly instead of letting it guess from host RAM.
MEMORY_PROFILE=low

# Optional, but useful when the panel console truncates scrollback.
LOG_FILE=logs/bot.log
LOG_FILE_MAX_BYTES=524288
LOG_FILE_KEEP=3
```

That is enough. The bot runs, picks tight cache limits, and caps its own log
files.

There is no longer any setting that `.env` cannot carry. The V8 heap used to be
the exception, because Node reads `NODE_OPTIONS` before any code runs — including
the code that reads `.env`. The bot now re-launches itself with the right value
instead, so a panel with nothing but a file manager is fully configurable.

The one thing worth checking in the panel is the **Node version**: these panels
pin one and ignore `engines`, and 22.15+ saves the ~45 MB described under
*Requirements*.

All diagnostics go to **stdout**, never stderr, because these panels stream
stdout to their console and frequently discard stderr — a diagnostic on stderr
is a diagnostic nobody reads.

### Bare `node`

```bash
npm install
node index.js
```

### Afterwards

Back up **`data/`**. It holds every server's settings, member records and
moderation history. Nothing else in the tree is stateful.

Upgrading is `git pull && npm install && restart` — settings merge over defaults
on read, so there is no migration step.

## Troubleshooting

### "This interaction failed"

Discord invalidates an interaction three seconds after the user pressed enter,
and that clock does not stop while the process is busy or paused. So this
message usually says nothing about the command — it says the process was not
running during those three seconds. The log distinguishes the two cases:

```
/game could not answer: Discord had already expired the interaction.
2907ms passed before the handler started, 41ms inside it.
```

Nearly all of the budget gone before the handler started means the delay is
upstream of any command code. Look for the companion warning:

```
the process was unresponsive for 2400ms
```

Common causes, in the order worth checking:

1. **An oversized V8 heap.** The bot handles this itself — see *Heap sizing*
   below — but check the boot log for a line saying it declined to.
2. **A free tier that idles the container.** The first command after a quiet
   period pays for the wake-up. Nothing in the bot can fix this.
3. **A shared vCPU out of burst credit.**

`/owner stats` reports the worst stall since boot. Anything approaching 3000 ms
there means commands will fail intermittently no matter what they do.

### Heap sizing

V8 chooses its maximum heap from the **host's** physical memory. A cgroup limit
is invisible to it before Node 20.3, and only partly visible after — so in a
256 MB container on a big machine it plans for about 4 GB, feels no pressure,
and either gets OOM-killed or stalls long enough to lose interactions.

The only cure is `--max-old-space-size`, which V8 reads before any JavaScript
runs. No config file can set it, `.env` included, and plenty of hosts give you
a repository and nothing else — no environment variables, no editable startup
command. So the bot re-launches itself once, with the flag:

```
[heap] V8 planned a 4144 MB heap inside a 256 MB limit.
       Restarting with --max-old-space-size=140 ...
```

On Node 22.15+ this uses `execve`: same process, same pid, nothing extra
resident. On older versions it costs a ~45 MB supervisor process, which is
deducted from the heap budget rather than ignored — which is why the same
container gets 140 MB on new Node and 116 MB on old. **Upgrading Node to 22.15
or newer gets that 45 MB back.**

It only acts when a container limit is actually detected, the limit is under
1 GB, and nobody set the flag themselves. `HEAP_AUTOSIZE=false` turns it off.

### npm install fails, or a plugin cannot find its package

Two separate problems with the same origin — a container where the project is
read-only and only `/tmp` is writable.

npm derives its cache from `HOME`, and fails before it fetches anything if that
directory does not exist, with a message that blames the network:

```
Invalid response body while trying to fetch https://registry.npmjs.org/ws:
ENOENT: no such file or directory, mkdir '/home/node/.npm'
```

The bot now passes npm an explicit cache directory, so this should not appear.
Packages themselves go to the first writable of: the project directory,
`DATA_DIR/npm`, then a temporary directory. `/plugin npm` reports which was used,
and plugins can `require()` from any of them. Set `PLUGIN_MODULES_DIR` to choose
explicitly.

Only the last of those is lost on restart, and the install says so when it
happens. If you see that, point `DATA_DIR` at something that persists.

### Every command answers twice, or logs "already answered by somebody else"

Two copies of the bot are running on the same token — commonly an old container
that was never stopped, or a local `node index.js` left over from testing. One
token, one process.

Several *different* bots in the same server is fine and unrelated: each is its
own application with its own token, and Discord keeps their commands apart.
