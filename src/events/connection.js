'use strict';

/**
 * Gateway connection lifecycle.
 *
 * Without these handlers a bot does not crash when Discord goes away - it does
 * something worse. It becomes a zombie: the process is alive, the gateway is
 * gone, nothing works, and because it never exited no supervisor restarts it.
 * You find out hours later when someone asks why the bot is ignoring them.
 *
 * Two specific hazards this closes:
 *
 *   1. `error` is an EventEmitter special case. With no listener, Node throws
 *      on emit. That lands in process.on('uncaughtException'), which logs and
 *      continues - leaving exactly the zombie described above.
 *
 *   2. `invalidated` means the session is dead and cannot be resumed: the token
 *      was reset, or the application was deleted. discord.js destroys the
 *      client and there is nothing left running. Sitting there quietly is the
 *      wrong answer; exiting lets the supervisor restart, and the next start
 *      fails at login with a message that says exactly what is wrong.
 *
 * Everything else - a dropped connection, a Discord outage, a rate limit - is
 * recoverable, and discord.js reconnects with its own backoff. Those are logged
 * so the recovery is visible, and not acted on.
 */

/** Gateway close codes discord.js will not reconnect from. */
const FATAL_CLOSE_CODES = {
  4004: 'authentication failed — the token is wrong or was reset',
  4010: 'invalid shard sent to the gateway',
  4011: 'this bot is in too many servers and now requires sharding',
  4012: 'invalid API version',
  4013: 'invalid gateway intents',
  4014: 'disallowed gateway intents — a privileged intent is off in the developer portal',
};

/** How long the gateway may stay down before the process gives up and exits. */
const DISCONNECT_GRACE_MS = 10 * 60_000;

/** Tracks a continuous outage so a stuck client does not linger forever. */
let outageTimer = null;

function beginOutage(bot, reason) {
  if (outageTimer) return;
  outageTimer = setTimeout(() => {
    bot.log.fatal(`the gateway has been unreachable for 10 minutes (${reason}).`);
    bot.log.fatal('exiting so the supervisor can restart with a clean connection.');
    bot.log.fatal('if nothing restarts this process, it would sit here doing nothing.');
    void bot
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(1));
  }, DISCONNECT_GRACE_MS);
  // Must not keep the process alive on its own.
  if (typeof outageTimer.unref === 'function') outageTimer.unref();
}

function endOutage() {
  if (!outageTimer) return;
  clearTimeout(outageTimer);
  outageTimer = null;
}

module.exports = [
  {
    // The EventEmitter special case. A listener here is what stops an emitted
    // 'error' from being thrown as an uncaught exception.
    name: 'error',
    execute(bot, error) {
      bot.counters.errors++;
      bot.log.error('gateway client error:', error);
    },
  },

  {
    name: 'shardError',
    execute(bot, error, shardId) {
      // "Used disallowed intents" arrives here on every rung of the login
      // ladder. Reporting it at error level makes a handled, expected step look
      // like a failure; login() already says what it is doing about it.
      if (!bot.readyAt) {
        bot.log.debug(`shard ${shardId} error during login: ${error?.message || error}`);
        return;
      }
      bot.counters.errors++;
      bot.log.error(`shard ${shardId} error:`, error);
    },
  },

  {
    name: 'shardDisconnect',
    execute(bot, event, shardId) {
      const code = event?.code;
      const fatal = FATAL_CLOSE_CODES[code];

      // Before the first successful ready, login() owns failure handling: it
      // walks an intent-fallback ladder that deliberately provokes 4014 and
      // retries with fewer intents. Exiting here would kill that mid-ladder -
      // which is exactly what happened when this handler was first written, and
      // it broke startup for anyone with a privileged intent switched off.
      if (!bot.readyAt) {
        bot.log.debug(`shard ${shardId} closed with code ${code ?? 'unknown'} during login; login() will handle it`);
        return;
      }

      if (fatal) {
        // discord.js will not retry these, so waiting is pointless.
        bot.log.fatal(`shard ${shardId} closed with code ${code}: ${fatal}`);
        if (code === 4014 || code === 4013) {
          bot.log.fatal('an intent was switched off in the developer portal while the bot was running.');
          bot.log.fatal('restarting will pick the largest intent set that is still allowed.');
        }
        bot.log.fatal('exiting — this will not recover on its own.');
        void bot
          .shutdown()
          .catch(() => {})
          .finally(() => process.exit(1));
        return;
      }

      bot.log.warn(`shard ${shardId} disconnected (code ${code ?? 'unknown'}), reconnecting…`);
      beginOutage(bot, `close code ${code ?? 'unknown'}`);
    },
  },

  {
    name: 'shardReconnecting',
    execute(bot, shardId) {
      bot.log.info(`shard ${shardId} is reconnecting`);
    },
  },

  {
    name: 'shardResume',
    execute(bot, shardId, replayed) {
      endOutage();
      bot.log.info(`shard ${shardId} resumed, ${replayed} event(s) replayed`);
    },
  },

  {
    name: 'shardReady',
    execute(bot, shardId) {
      endOutage();
      bot.log.info(`shard ${shardId} ready`);
    },
  },

  {
    /**
     * The session cannot be resumed and will not be re-established: the token
     * was reset, or the application was deleted. discord.js has already
     * destroyed the client, so there is nothing left to keep alive.
     */
    name: 'invalidated',
    execute(bot) {
      // Same reasoning as shardDisconnect: during the login ladder, login()
      // decides what to do next.
      if (!bot.readyAt) {
        bot.log.debug('session invalidated during login; login() will handle it');
        return;
      }
      bot.log.fatal('the gateway session was invalidated and cannot be resumed.');
      bot.log.fatal('the usual causes are the bot token being reset, or the application being deleted.');
      bot.log.fatal('flushing data and exiting; on restart, login will report exactly which it was.');
      void bot
        .shutdown()
        .catch(() => {})
        .finally(() => process.exit(1));
    },
  },

  {
    name: 'warn',
    execute(bot, message) {
      bot.log.warn(`discord.js: ${message}`);
    },
  },

  {
    // Being rate limited is normal under load and recovers by itself; it is
    // logged because a persistent one usually means a loop somewhere.
    name: 'rateLimited',
    execute(bot, info) {
      bot.log.warn(
        `rate limited for ${info?.timeToReset ?? '?'}ms on ${info?.method ?? '?'} ${info?.route ?? '?'}` +
          (info?.global ? ' (global)' : ''),
      );
    },
  },
];
