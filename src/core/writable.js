'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Writability checks for read-only filesystems.
 *
 * Containers are increasingly read-only by default — `docker run --read-only`,
 * Cloud Run, Fly without a volume, several PaaS free tiers — with only /tmp
 * mounted writable. Without a check, the failures are opaque: a raw EROFS from
 * mkdir during boot, or an EACCES thrown out of a plugin install.
 *
 * The two directories need *different* answers, and that distinction is the
 * whole point of this module:
 *
 *   DATA_DIR  holds every server's settings, member records and moderation
 *             history. Silently relocating it to /tmp would look like it worked
 *             and then lose everything on the next restart, repeatedly, with no
 *             sign anything was wrong. So this only detects and reports; the
 *             operator decides whether ephemeral storage is acceptable.
 *
 *   The plugins directory holds code fetched from elsewhere, which can be
 *             fetched again. Falling back to a scratch directory is genuinely
 *             useful there — the install works, and it is reported as
 *             temporary so nobody is surprised when it is gone.
 */

/**
 * Can this directory be created and written to?
 * Creates it when missing, which is part of the question being asked.
 *
 * @returns {{ ok: boolean, reason?: string, code?: string }}
 */
function check(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, code: e.code, reason: `cannot create it: ${e.message}` };
  }

  // Existing and creatable is not the same as writable: a read-only bind mount
  // lets mkdir succeed for a path that already exists, then refuses the write.
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code, reason: `cannot write in it: ${e.message}` };
  }
}

/** Convenience wrapper for a boolean answer. */
function isWritable(dir) {
  return check(dir).ok;
}

/**
 * A writable scratch directory, for things that may legitimately be temporary.
 * Namespaced by pid so two bots on one host do not collide.
 */
function scratchDir(name) {
  const dir = path.join(os.tmpdir(), `mulebot-${name}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Explains a read-only data directory in terms of what to do about it.
 * Returned as lines so the caller can log them at whatever level fits.
 */
function dataDirAdvice(dir, result) {
  return [
    `the data directory ${dir} is not writable — ${result.reason}`,
    '',
    'This directory holds every server\'s settings, member records and moderation',
    'history, so the bot will not start without somewhere to put them.',
    '',
    'On a host with a read-only filesystem, pick one:',
    '  - mount a volume and point DATA_DIR at it (settings survive restarts)',
    '  - set DATA_DIR=/tmp/mulebot to accept that everything resets on restart',
    '',
    'This is not done automatically: relocating to /tmp silently would look like',
    'it worked, then lose every configuration on the next restart.',
  ];
}

module.exports = { check, isWritable, scratchDir, dataDirAdvice };
