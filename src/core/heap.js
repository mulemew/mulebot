'use strict';

const v8 = require('node:v8');
const { containerMemoryLimitMb } = require('./cache');

/**
 * Heap autosizing.
 *
 * V8 picks its maximum old-space size from the *host's* physical memory and has
 * no idea that a cgroup limit exists. In a 256 MB container on a 8 GB machine it
 * therefore plans for roughly 4 GB, never feels any pressure, and the container
 * gets OOM-killed - or stalls long enough that Discord expires an interaction -
 * while V8 is still convinced it has gigabytes spare. The JVM fixed this in 2018
 * with UseContainerSupport; Node still has nothing equivalent.
 *
 * --max-old-space-size fixes it, but only if it is set before the process
 * starts, which rules out .env, config files and anything else read at runtime.
 * That is a genuine problem rather than a documentation one: plenty of hosts
 * give you a repository and nothing else - no environment variables, no editable
 * startup command. Telling those users to "just set NODE_OPTIONS" is telling
 * them to use a different host.
 *
 * So the process re-launches itself with the correct flag. It is a blunt thing
 * for a program to do, hence the deliberately narrow conditions in decide():
 * only when a container limit is actually detected, only when it is small
 * enough for the default to be dangerous, only when nobody has expressed an
 * opinion of their own, and only once.
 */

/** Set on the re-launched process so it can never re-launch again. */
const GUARD = 'BOT_HEAP_SIZED';

/** Fraction of the container limit to give the heap. */
const HEAP_FRACTION = 0.55;

/** Never propose a heap smaller than this; below it Node cannot start. */
const FLOOR_MB = 48;

/**
 * Only intervene below this. Above it V8's own sizing is close enough, and the
 * risk of second-guessing the runtime outweighs the benefit.
 */
const CEILING_MB = 1024;

/** Limits under this are not believable and are more likely a parsing mistake. */
const SANITY_FLOOR_MB = 64;

/**
 * Cost of the supervisor process on the fallback path, measured rather than
 * guessed: a parked Node 18 parent that has loaded only this module sits at
 * 45 MB RSS in a 256 MB container. It is dead weight, but the alternative on a
 * runtime without execve is no re-launch at all.
 */
const SUPERVISOR_MB = 45;

/** True when re-launching will leave a supervisor behind rather than execve. */
function willSupervise() {
  return typeof process.execve !== 'function' || process.platform === 'win32';
}

/**
 * What the heap should be capped at for a given container limit.
 *
 * The supervisor's memory is spent before the bot allocates anything, so on
 * that path it comes off the top - budgeting 55% of the full limit would hand
 * the heap memory that is already gone.
 */
function targetFor(limitMb, { supervised = false } = {}) {
  const usable = supervised ? Math.max(SANITY_FLOOR_MB, limitMb - SUPERVISOR_MB) : limitMb;
  return Math.max(FLOOR_MB, Math.floor(usable * HEAP_FRACTION));
}

/** True when something already set the flag, whichever way it was passed. */
function alreadySet(execArgv, env) {
  const written = [...execArgv, env.NODE_OPTIONS || ''].join(' ');
  return /--max[-_]old[-_]space[-_]size/.test(written);
}

/**
 * Decides whether to re-launch, and returns the reason either way so the caller
 * can log a single honest line. Pure, so the tests can drive every branch
 * without spawning anything.
 */
function decide({
  limitMb = containerMemoryLimitMb(),
  env = process.env,
  execArgv = process.execArgv,
  plannedHeapMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
  supervised = willSupervise(),
} = {}) {
  if (env[GUARD]) {
    return { resize: false, reason: 'already sized', plannedHeapMb, limitMb };
  }
  if (String(env.HEAP_AUTOSIZE).toLowerCase() === 'false') {
    return { resize: false, reason: 'disabled by HEAP_AUTOSIZE=false', plannedHeapMb, limitMb };
  }
  if (alreadySet(execArgv, env)) {
    return { resize: false, reason: 'the flag is already set', plannedHeapMb, limitMb };
  }
  if (!limitMb) {
    // No cgroup limit: this is a normal VPS or a desktop, where V8's sizing is
    // correct because the host memory it read is the memory that exists.
    return { resize: false, reason: 'not running under a memory limit', plannedHeapMb, limitMb };
  }
  if (limitMb < SANITY_FLOOR_MB) {
    return { resize: false, reason: `detected limit of ${limitMb} MB is not plausible`, plannedHeapMb, limitMb };
  }
  if (limitMb >= CEILING_MB) {
    return { resize: false, reason: `${limitMb} MB is roomy enough for V8's own sizing`, plannedHeapMb, limitMb };
  }

  const targetMb = targetFor(limitMb, { supervised });
  if (plannedHeapMb <= limitMb) {
    // V8 already intends to stay inside the limit, so there is nothing to fix.
    return { resize: false, reason: `V8 already plans ${plannedHeapMb} MB`, plannedHeapMb, limitMb, targetMb };
  }

  return {
    resize: true,
    reason: `V8 planned a ${plannedHeapMb} MB heap inside a ${limitMb} MB limit`,
    plannedHeapMb,
    limitMb,
    targetMb,
  };
}

/**
 * The command line the re-launched process should get, excluding argv[0].
 *
 * spawn supplies argv[0] itself from the executable path. execve does not - it
 * takes the full vector, so the caller there has to prepend it. Getting that
 * wrong is silent rather than fatal: execve consumes the first element as the
 * program name, so the flag disappears and the new process comes up with
 * exactly the oversized heap it was launched to avoid.
 */
function relaunchArgs(targetMb, { execArgv = process.execArgv, argv = process.argv } = {}) {
  return [`--max-old-space-size=${targetMb}`, ...execArgv, ...argv.slice(1)];
}

/**
 * Re-launches this process with the flag applied. Does not return when it
 * succeeds.
 *
 * execve replaces the process image: same pid, same stdio, no supervisor left
 * behind. That matters here because the whole point is a host with very little
 * memory, and a parent sitting around waiting would cost another ~40 MB of the
 * 256 being rationed. It is POSIX-only, so Windows falls back to a child
 * process, where the parent's cost is real but the host is not a 256 MB
 * container either.
 */
function relaunch(targetMb, { log = () => {} } = {}) {
  const env = { ...process.env, [GUARD]: String(targetMb) };
  const args = relaunchArgs(targetMb);

  if (typeof process.execve === 'function') {
    try {
      process.execve(process.execPath, [process.execPath, ...args], env);
      return { relaunched: true, method: 'execve' }; // unreachable
    } catch (e) {
      // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on Windows, EACCES on a locked-down
      // host. Either way there is still the child-process route.
      log(`could not replace the process image (${e.code || e.message}), starting a child instead`);
    }
  }

  log(
    `[heap] this Node cannot replace its own process image, so the bot runs as a child process. ` +
      `That supervisor costs about ${SUPERVISOR_MB} MB, already deducted from the heap budget above. ` +
      'Node 22.15 or newer removes it entirely.',
  );

  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });

  if (!child.pid) {
    log('could not re-launch with a sized heap, continuing with the heap V8 chose');
    return { relaunched: false, method: 'spawn' };
  }

  // Signals have to be forwarded by hand. Docker, systemd and every panel send
  // SIGTERM to pid 1 alone rather than to the process group, so without this the
  // supervisor absorbs the stop signal, the real bot never hears about it, and
  // the shutdown that flushes the database to disk never runs - which turns
  // every redeploy into silent data loss. (spawnSync would be simpler and cannot
  // do this: a process blocked in a synchronous call runs no JS handlers.)
  const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  for (const signal of FORWARDED) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    });
  }

  child.on('error', (e) => {
    log(`the re-launched process failed to start (${e.message})`);
    process.exit(1);
  });

  // Exit the way the child did, so a panel's restart policy and the connection
  // tests both see the same code they would have without the supervisor.
  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise rather than translating, so a supervisor reading wait status
      // sees the same signal death it would have seen without the wrapper.
      // The forwarders have to come off first: with a listener still attached
      // the re-raised signal is delivered to it instead of killing anything,
      // and the process hangs forever waiting on a child that already exited.
      for (const s of FORWARDED) process.removeAllListeners(s);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  return { relaunched: true, method: 'spawn', pid: child.pid };
}

/**
 * The whole thing: decide, log one line, and re-launch if warranted.
 * Called from index.js before anything heavy is loaded.
 */
function autosize({ log = () => {} } = {}) {
  const verdict = decide();
  if (!verdict.resize) return verdict;

  log(
    `[heap] ${verdict.reason}. Restarting with --max-old-space-size=${verdict.targetMb} ` +
      'so V8 collects before the host runs out.',
  );
  return { ...verdict, ...relaunch(verdict.targetMb, { log }) };
}

module.exports = {
  autosize,
  decide,
  relaunch,
  relaunchArgs,
  targetFor,
  willSupervise,
  GUARD,
  CEILING_MB,
  HEAP_FRACTION,
  SUPERVISOR_MB,
};
