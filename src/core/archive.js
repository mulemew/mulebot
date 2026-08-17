'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Minimal ZIP and tar.gz readers.
 *
 * Node ships zlib but no archive format, and pulling in a dependency for
 * something the bot uses on one code path is a poor trade on a host where the
 * whole runtime is 27 MB. Both formats are simple enough to read directly:
 * ZIP is a central directory of deflate streams, tar is 512-byte headers.
 *
 * Only reading is implemented, and only what a plugin bundle needs.
 *
 * Every entry path is validated before anything is written. An archive is
 * attacker-controlled input - "zip slip", where an entry named
 * ../../etc/cron.d/x escapes the extraction directory, is the classic way an
 * upload feature becomes host compromise.
 */

const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_BYTES = 16 * 1024 * 1024;

/**
 * Rejects an entry path that would escape the destination.
 * @returns {string|null} the safe relative path, or null when it must be skipped
 */
function safeEntryPath(name) {
  if (!name) return null;
  // Normalise separators; some writers emit backslashes.
  const cleaned = String(name).replace(/\\/g, '/');

  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return null; // absolute
  if (cleaned.split('/').some((part) => part === '..')) return null; // traversal
  if (cleaned.includes('\0')) return null;
  // Skip macOS and editor cruft rather than failing the whole archive.
  if (cleaned.startsWith('__MACOSX/') || cleaned.includes('/.DS_Store') || cleaned === '.DS_Store') return null;
  return cleaned;
}

/**
 * Reads a ZIP archive from a buffer.
 * @returns {Array<{ path: string, data: Buffer }>}
 */
function readZip(buffer) {
  // Locate the End Of Central Directory record, scanning back from the end
  // because it is followed by a variable-length comment.
  const SIG_EOCD = 0x06054b50;
  let eocd = -1;
  const from = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) throw new Error(`archive has ${entryCount} entries, the limit is ${MAX_ENTRIES}`);

  const out = [];
  let total = 0;

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // directory entry
    const safe = safeEntryPath(name);
    if (!safe) continue;

    if (uncompressedSize > MAX_SINGLE_BYTES) throw new Error(`${name} is larger than the per-file limit`);
    total += uncompressedSize;
    // Guards against a zip bomb: a small archive that expands to gigabytes.
    if (total > MAX_TOTAL_BYTES) throw new Error('archive expands beyond the total size limit');

    // The local header repeats the name and extra fields with its own lengths.
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt local file header');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_SINGLE_BYTES });
    else throw new Error(`${name} uses unsupported compression method ${method}`);

    out.push({ path: safe, data });
  }

  return out;
}

/**
 * Reads a tar archive from a buffer, gunzipping first when needed.
 * @returns {Array<{ path: string, data: Buffer }>}
 */
function readTar(buffer) {
  // gzip magic
  let body = buffer;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    body = zlib.gunzipSync(buffer, { maxOutputLength: MAX_TOTAL_BYTES });
  }

  const out = [];
  let offset = 0;
  let total = 0;
  let longName = null;

  while (offset + 512 <= body.length) {
    const header = body.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end.
    if (header.every((b) => b === 0)) break;

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');

    offset += 512;
    const dataStart = offset;
    offset += Math.ceil(size / 512) * 512;

    // GNU long-name extension: the next entry's name lives in this record.
    if (type === 'L') {
      longName = body.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/, '');
      continue;
    }

    const name = longName || (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;

    if (type !== '0' && type !== '\0' && type !== '') continue; // only regular files
    const safe = safeEntryPath(name);
    if (!safe) continue;

    if (size > MAX_SINGLE_BYTES) throw new Error(`${name} is larger than the per-file limit`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('archive expands beyond the total size limit');
    if (out.length >= MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries`);

    out.push({ path: safe, data: Buffer.from(body.subarray(dataStart, dataStart + size)) });
  }

  return out;
}

/** Detects the format from the magic bytes and reads it. */
function read(buffer) {
  if (buffer.length < 4) throw new Error('file is too small to be an archive');
  if (buffer.readUInt32LE(0) === 0x04034b50 || buffer.readUInt32LE(0) === 0x06054b50) return readZip(buffer);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return readTar(buffer);
  // A plain tar has "ustar" at offset 257.
  if (buffer.length > 262 && buffer.toString('ascii', 257, 262) === 'ustar') return readTar(buffer);
  throw new Error('unrecognised archive format (expected .zip, .tar or .tar.gz)');
}

/**
 * Extracts an archive into `destination`.
 *
 * When every entry shares one top-level directory - which is what GitHub's
 * "Download ZIP" produces - that wrapper is stripped, so `myplugin-main/` does
 * not become `myplugin/myplugin-main/index.js`.
 *
 * @returns {{ files: string[], stripped: string|null }}
 */
function extract(buffer, destination) {
  const entries = read(buffer);
  if (!entries.length) throw new Error('the archive contains no files');

  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const stripped = tops.size === 1 && entries.every((e) => e.path.includes('/')) ? [...tops][0] : null;

  const written = [];
  for (const entry of entries) {
    const relative = stripped ? entry.path.slice(stripped.length + 1) : entry.path;
    if (!relative) continue;

    const target = path.resolve(destination, relative);
    // Final check after resolution, independent of the per-entry validation.
    if (target !== path.resolve(destination) && !target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error(`entry "${entry.path}" would escape the extraction directory`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    written.push(relative);
  }

  return { files: written, stripped };
}

module.exports = { read, readZip, readTar, extract, safeEntryPath, MAX_TOTAL_BYTES, MAX_SINGLE_BYTES };
