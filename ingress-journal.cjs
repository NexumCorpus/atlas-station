'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const MAX_CLAIM_TTL_MS = 86400000;
const IMAGE_COUNT_LIMIT = 4;
const IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;
const IMAGE_TOTAL_BYTES_LIMIT = 12 * 1024 * 1024;
const IMAGE_DIMENSION_LIMIT = 8192;
const IMAGE_PIXEL_LIMIT = 20_000_000;
const IMAGE_TOTAL_PIXEL_LIMIT = 32_000_000;
const IMAGE_ORPHAN_GRACE_MS = 5 * 60 * 1000;
const IMAGE_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const imageSweepDirectories = new Map();
const imageVerificationCache = new Map();
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngShape(bytes, inflate = true) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) assert.fail('image magic bytes do not match image/png');
  if (bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(Buffer.from('IHDR', 'ascii'))) assert.fail('image/png does not begin with a canonical IHDR chunk');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width > IMAGE_DIMENSION_LIMIT || height > IMAGE_DIMENSION_LIMIT || width * height > IMAGE_PIXEL_LIMIT) assert.fail('image dimensions exceed screenshot limits');
  const bitDepth = bytes[24]; const colorType = bytes[25];
  const depths = { 0: [1, 2, 4, 8], 2: [8], 3: [1, 2, 4, 8], 4: [8], 6: [8] };
  if (!depths[colorType]?.includes(bitDepth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) assert.fail('image/png IHDR fields are invalid or interlaced');
  let offset = 8; let sawIhdr = false; let sawIdat = false; let sawIend = false; let sawPlte = false; let idatClosed = false; const idat = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) assert.fail('image/png chunk framing is truncated');
    const length = bytes.readUInt32BE(offset); const dataEnd = offset + 12 + length;
    if (length > IMAGE_BYTES_LIMIT || dataEnd > bytes.length) assert.fail('image/png chunk length exceeds the admitted payload');
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii'); const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (bytes.readUInt32BE(offset + 8 + length) !== pngCrc32(bytes.subarray(offset + 4, offset + 8 + length))) assert.fail('image/png chunk CRC is invalid');
    if (!sawIhdr && type !== 'IHDR' || sawIhdr && type === 'IHDR') assert.fail('image/png IHDR ordering is invalid');
    if (type === 'IHDR') sawIhdr = true;
    else if (type === 'PLTE') { if (sawIdat) assert.fail('image/png PLTE follows image data'); sawPlte = true; }
    else if (type === 'IDAT') { if (idatClosed) assert.fail('image/png IDAT chunks are not contiguous'); sawIdat = true; idat.push(data); }
    else if (type === 'IEND') { if (length !== 0 || !sawIdat || dataEnd !== bytes.length) assert.fail('image/png IEND is invalid'); sawIend = true; }
    else { if (sawIdat) idatClosed = true; if (/^[A-Z]/.test(type)) assert.fail('image/png contains an unknown critical chunk'); }
    offset = dataEnd;
  }
  if (!sawIhdr || !sawIdat || !sawIend || colorType === 3 && !sawPlte) assert.fail('image/png required chunks are missing');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]; const rowBytes = Math.ceil(width * channels * bitDepth / 8); const decodedBytes = height * (rowBytes + 1);
  if (decodedBytes > 80 * 1024 * 1024) assert.fail('image/png decoded byte size exceeds screenshot limits');
  if (inflate) {
    let inflated; try { inflated = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: decodedBytes }); } catch { assert.fail('image/png image data is not decodable'); }
    if (inflated.length !== decodedBytes) assert.fail('image/png decoded image size is invalid');
    for (let row = 0; row < height; row++) if (inflated[row * (rowBytes + 1)] > 4) assert.fail('image/png row filter is invalid');
  }
  return { width, height, decodedBytes };
}
const IMAGE_TYPES = Object.freeze({
  'image/png': { ext: 'png', shape: pngShape },
});

function bytesHash(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function hash(value) { return bytesHash(JSON.stringify(value)); }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function admitClaimTtl(value) {
  const requestedClaimTtlMs = value;
  if (!Number.isSafeInteger(requestedClaimTtlMs) || requestedClaimTtlMs < 1 || requestedClaimTtlMs > MAX_CLAIM_TTL_MS) throw new Error(`claim TTL must be an integer from 1 through ${MAX_CLAIM_TTL_MS}`);
  const effectiveClaimTtlMs = requestedClaimTtlMs === 1 ? 1 : Math.max(1000, requestedClaimTtlMs);
  return { requestedClaimTtlMs, effectiveClaimTtlMs };
}
function canonicalDir(dir) {
  const resolved = path.resolve(dir || path.join(__dirname, '.atlas'));
  return resolved === path.resolve(__dirname) ? path.join(resolved, '.atlas') : resolved;
}
function paths(dir) { const root = canonicalDir(dir); return { journal: path.join(root, 'ingress.ndjson'), quarantine: path.join(root, 'ingress-quarantine.ndjson'), migration: path.join(root, 'ingress-migration-anchor.json'), lock: path.join(root, 'ingress.lock'), errors: path.join(root, 'sidecar-errors.ndjson') }; }
function readJsonLines(file) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map(line => JSON.parse(line)); }
function appendFileSync(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, body, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function appendImageCleanupReceipt(dir, record) { try { appendFileSync(paths(dir).errors, JSON.stringify(record) + '\n'); return true; } catch { return false; } }

function imageHash(bytes) { return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`; }
function inside(child, parent) { const relative = path.relative(parent, child); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
function decodeImageDataUrl(value, inflate = true) {
  const dataUrl = typeof value === 'string' ? value : value && typeof value === 'object' ? value.durl : '';
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(IMAGE_BYTES_LIMIT / 3) * 4 + 64) assert.fail('image payload exceeds encoded byte limit');
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) assert.fail('image payload must be canonical PNG base64');
  const bytes = Buffer.from(match[2], 'base64');
  const canonical = bytes.toString('base64');
  if (!bytes.length || bytes.length > IMAGE_BYTES_LIMIT || canonical !== match[2]) assert.fail('image payload failed canonical size validation');
  const type = IMAGE_TYPES[match[1]];
  const shape = type.shape(bytes, inflate);
  return { bytes, mime: match[1], ext: type.ext, ...shape };
}
function persistImageDataUrls(dir, values) {
  if (!Array.isArray(values) || !values.length || values.length > IMAGE_COUNT_LIMIT) assert.fail(`image count must be from 1 through ${IMAGE_COUNT_LIMIT}`);
  dir = canonicalDir(dir);
  const mediaDir = path.join(dir, 'say-inbox-media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const admitted = values.map(value => decodeImageDataUrl(value, false));
  const total = admitted.reduce((sum, image) => sum + image.bytes.length, 0);
  if (total > IMAGE_TOTAL_BYTES_LIMIT) assert.fail(`image batch exceeds ${IMAGE_TOTAL_BYTES_LIMIT} bytes`);
  const pixels = admitted.reduce((sum, image) => sum + image.width * image.height, 0);
  if (pixels > IMAGE_TOTAL_PIXEL_LIMIT) assert.fail(`image batch exceeds ${IMAGE_TOTAL_PIXEL_LIMIT} decoded pixels`);
  const decodedBytes = admitted.reduce((sum, image) => sum + image.decodedBytes, 0);
  if (decodedBytes > 128 * 1024 * 1024) assert.fail('image batch exceeds decoded byte limits');
  for (const image of admitted) IMAGE_TYPES[image.mime].shape(image.bytes, true);
  const written = [];
  try {
    for (const image of admitted) {
      const file = path.join(mediaDir, `${Date.now()}-${crypto.randomUUID()}.${image.ext}`);
      fs.writeFileSync(file, image.bytes, { flag: 'wx', mode: 0o600 });
      written.push({ path: file, mime: image.mime, bytes: image.bytes.length, sha256: imageHash(image.bytes), width: image.width, height: image.height, decodedBytes: image.decodedBytes });
    }
    return written;
  } catch (error) {
    for (const image of written) try { fs.unlinkSync(image.path); } catch {}
    assert.fail(error);
  }
}
function readImageAttachment(dir, value, inflate = true) {
  const mediaDir = path.join(canonicalDir(dir), 'say-inbox-media');
  let mediaRoot;
  try { mediaRoot = fs.realpathSync(mediaDir); } catch { assert.fail('image media root is unavailable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) assert.fail('image attachment metadata must be an object');
  const mime = String(value.mime || ''); const expected = IMAGE_TYPES[mime];
  if (!expected) assert.fail('image attachment MIME is not admitted');
  const candidate = path.resolve(String(value.path || ''));
  let stat; try { stat = fs.lstatSync(candidate); } catch { assert.fail('image attachment is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink()) assert.fail('image attachment must be a regular file');
  const real = fs.realpathSync(candidate);
  if (!inside(real, mediaRoot)) assert.fail('image attachment escaped the media root');
  let handle;
  try {
    handle = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(handle);
    if (!before.isFile() || before.size < 1 || before.size > IMAGE_BYTES_LIMIT || Number(value.bytes) !== before.size) assert.fail('image attachment byte receipt mismatch');
    const data = Buffer.allocUnsafe(before.size); let total = 0;
    while (total < data.length) { const count = fs.readSync(handle, data, total, data.length - total, null); if (!count) break; total += count; }
    const after = fs.fstatSync(handle);
    if (total !== before.size || after.size !== total) assert.fail('image attachment changed during read');
    const sha256 = imageHash(data); const identity = [real, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, sha256].join('|');
    let shape = imageVerificationCache.get(identity);
    if (!shape) {
      shape = expected.shape(data, inflate);
      if (inflate) {
        if (imageVerificationCache.size >= 128) imageVerificationCache.delete(imageVerificationCache.keys().next().value);
        imageVerificationCache.set(identity, shape);
      }
    }
    if (String(value.sha256 || '') !== sha256 || (value.width != null && Number(value.width) !== shape.width) || (value.height != null && Number(value.height) !== shape.height) || (value.decodedBytes != null && Number(value.decodedBytes) !== shape.decodedBytes)) assert.fail('image attachment receipt mismatch');
    return { path: real, mime, bytes: total, sha256, ...shape, data };
  } finally { try { if (handle !== undefined) fs.closeSync(handle); } catch {} }
}
function admitImageAttachments(dir, values) {
  if (!Array.isArray(values) || !values.length || values.length > IMAGE_COUNT_LIMIT) assert.fail(`image attachment count must be from 1 through ${IMAGE_COUNT_LIMIT}`);
  let total = 0; let pixels = 0; let decodedBytes = 0;
  const inspected = values.map((value) => {
    const image = readImageAttachment(dir, value, false); total += image.bytes;
    if (total > IMAGE_TOTAL_BYTES_LIMIT) assert.fail(`image batch exceeds ${IMAGE_TOTAL_BYTES_LIMIT} bytes`);
    pixels += image.width * image.height;
    if (pixels > IMAGE_TOTAL_PIXEL_LIMIT) assert.fail(`image batch exceeds ${IMAGE_TOTAL_PIXEL_LIMIT} decoded pixels`);
    decodedBytes += image.decodedBytes;
    if (decodedBytes > 128 * 1024 * 1024) assert.fail('image batch exceeds decoded byte limits');
    return image;
  });
  return inspected.map((_, index) => {
    const image = readImageAttachment(dir, values[index], true);
    return Object.freeze({ path: image.path, mime: image.mime, bytes: image.bytes, sha256: image.sha256, width: image.width, height: image.height, decodedBytes: image.decodedBytes });
  });
}
function removeImageAttachments(dir, values) {
  if (!Array.isArray(values)) return 0;
  const mediaDir = path.join(canonicalDir(dir), 'say-inbox-media');
  let root; try { root = fs.realpathSync(mediaDir); } catch { return 0; }
  let removed = 0; let failed = 0;
  for (const value of values.slice(0, IMAGE_COUNT_LIMIT)) {
    try {
      const candidate = path.resolve(String(value && value.path || '')); const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const real = fs.realpathSync(candidate); if (!inside(real, root)) continue;
      fs.unlinkSync(real); removed++;
    } catch (error) { if (error && error.code !== 'ENOENT') failed++ }
  }
  if (failed) appendImageCleanupReceipt(dir, { kind: 'image-cleanup', ts: new Date().toISOString(), removed, failed });
  return removed;
}

function sweepImageAttachments(dir, graceMs = IMAGE_ORPHAN_GRACE_MS) {
  dir = canonicalDir(dir);
  const mediaDir = path.join(dir, 'say-inbox-media');
  const names = [];
  let directory = imageSweepDirectories.get(mediaDir);
  let directoryFailed = false;
  try {
    if (!directory) { directory = fs.opendirSync(mediaDir); imageSweepDirectories.set(mediaDir, directory); }
    while (names.length < 512) {
      const entry = directory.readSync();
      if (!entry) { directory.closeSync(); imageSweepDirectories.delete(mediaDir); directory = null; break; }
      names.push(entry.name);
    }
  } catch { directoryFailed = true; return { scanned: 0, removed: 0, failed: 0, deferred: 0 }; }
  finally {
    if (directoryFailed) {
      try { directory?.closeSync(); } catch {}
      imageSweepDirectories.delete(mediaDir);
    }
  }
  let snapshot;
  try { snapshot = entries(dir); }
  catch {
    appendImageCleanupReceipt(dir, { kind: 'image-sweep', ts: new Date().toISOString(), scanned: names.length, removed: 0, failed: 1, deferred: names.length, reason: 'journal-unreadable' });
    return { scanned: names.length, removed: 0, failed: 1, deferred: names.length };
  }
  const active = new Set();
  for (const item of snapshot.byId.values()) if (item.ingress && (!item.terminal || (item.terminal.blocked && item.terminal.recoverable && Date.now() - Date.parse((item.replayRecoveries.at(-1) || item.terminal).ts) <= IMAGE_RECOVERY_RETENTION_MS))) {
    for (const image of Array.isArray(item.ingress.attachments) ? item.ingress.attachments : []) active.add(path.resolve(String(image.path || '')));
  }
  let removed = 0; let failed = 0; let deferred = 0; const cutoff = Date.now() - Math.max(60_000, Number(graceMs) || IMAGE_ORPHAN_GRACE_MS);
  for (const name of names) {
    const candidate = path.join(mediaDir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || active.has(path.resolve(candidate)) || stat.mtimeMs > cutoff) { deferred++; continue; }
      fs.unlinkSync(candidate); removed++;
    } catch { failed++ }
  }
  if (removed || failed) appendImageCleanupReceipt(dir, { kind: 'image-sweep', ts: new Date().toISOString(), scanned: names.length, removed, failed, deferred });
  return { scanned: names.length, removed, failed, deferred };
}

function withLock(dir, fn) {
  dir = canonicalDir(dir);
  fs.mkdirSync(dir, { recursive: true }); const lock = paths(dir).lock; let fd = null;
  for (let i = 0; i < 6000; i++) { try { fd = fs.openSync(lock, 'wx'); break; } catch (error) { if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error; try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.unlinkSync(lock); } catch {} sleep(5); } }
  if (fd == null) throw new Error('ingress writer lock timeout');
  try { fs.writeSync(fd, `${process.pid}\n`, null, 'utf8'); fs.fsyncSync(fd); return fn(); }
  finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
}

function quarantine(dir, entries) {
  if (!entries.length) return;
  appendFileSync(paths(dir).quarantine, entries.map(entry => JSON.stringify({ kind: 'quarantine', ts: new Date().toISOString(), ...entry })).join('\n') + '\n');
}

function salvageIngress(dir, suffix) {
  dir = canonicalDir(dir);
  const salvaged = [];
  for (const line of String(suffix || '').split(/\r?\n/).filter(Boolean)) {
    try { const row = JSON.parse(line); if (row.kind === 'ingress' && row.text != null) salvaged.push({ eventId: row.eventId || row.directiveId, directiveId: row.directiveId || row.eventId, idempotencyKey: row.idempotencyKey || null, source: row.source || 'salvaged', text: row.text, contentHash: row.contentHash || bytesHash(row.text) }); } catch {}
  }
  if (salvaged.length) appendFileSync(path.join(dir, 'ingress-salvage.ndjson'), salvaged.map(row => JSON.stringify({ kind: 'salvaged-ingress', ...row, ts: new Date().toISOString() })).join('\n') + '\n');
  return salvaged;
}

function parseJournal(dir, repair = true) {
  dir = canonicalDir(dir);
  const file = paths(dir).journal; if (!fs.existsSync(file)) return { records: [], lastHash: null, validBytes: 0 };
  const raw = fs.readFileSync(file); const records = []; let offset = 0; let expectedSeq = 1; let priorHash = null; let invalid = null; let anchored = false; let migrationAnchor = null;
  while (offset < raw.length) {
    const end = raw.indexOf(0x0a, offset); if (end < 0) { invalid = { offset, reason: 'torn-tail', bytes: raw.subarray(offset).toString('utf8') }; break; }
    const lineBytes = raw.subarray(offset, end); const text = lineBytes.toString('utf8'); let record;
    try { record = JSON.parse(text); } catch { invalid = { offset, reason: 'invalid-json', bytes: text }; break; }
    const expectedHash = record.recordHash; const copy = { ...record }; delete copy.recordHash;
    const hashOk = expectedHash === hash(copy);
    const seqOk = Number(record.seq) === expectedSeq;
    const chainOk = anchored ? record.priorHash === priorHash : (record.priorHash == null || record.priorHash === priorHash);
    if (!hashOk || !seqOk || !chainOk) { invalid = { offset, reason: !hashOk ? 'record-hash-mismatch' : !seqOk ? 'sequence-gap' : 'prior-hash-mismatch', record, expectedSeq, priorHash }; break; }
    if (!anchored && record.priorHash != null) { anchored = true; migrationAnchor = { seq: record.seq, recordHash: record.recordHash, priorHash: record.priorHash }; if (repair && !fs.existsSync(paths(dir).migration)) { const anchor = { schema: 1, kind: 'migration-anchor', ...migrationAnchor, signedHash: hash(migrationAnchor), createdAt: new Date().toISOString() }; const afd = fs.openSync(paths(dir).migration, 'w'); try { fs.writeSync(afd, JSON.stringify(anchor), null, 'utf8'); fs.fsyncSync(afd); } finally { fs.closeSync(afd); } } }
    records.push(record); priorHash = record.recordHash; expectedSeq++; offset = end + 1;
  }
  if (migrationAnchor && fs.existsSync(paths(dir).migration)) {
    try {
      const anchor = JSON.parse(fs.readFileSync(paths(dir).migration, 'utf8'));
      const signed = { seq: anchor.seq, recordHash: anchor.recordHash, priorHash: anchor.priorHash };
      if (anchor.kind !== 'migration-anchor' || anchor.signedHash !== hash(signed) || hash(signed) !== hash(migrationAnchor)) throw new Error('migration anchor mismatch');
    } catch (error) {
      throw new Error(`migration anchor verification failed: ${error.message}`);
    }
  }
  if (invalid && repair) withLock(dir, () => {
    const fresh = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    const suffix = fresh.subarray(invalid.offset).toString('utf8'); quarantine(dir, [{ reason: invalid.reason, byteOffset: invalid.offset, suffixHash: bytesHash(fresh.subarray(invalid.offset)), suffixBytes: suffix.slice(0, 8192) }]); salvageIngress(dir, suffix);
    const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, invalid.offset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  return { records, lastHash: priorHash, validBytes: offset, invalid, migrationAnchor };
}

function readJournal(dir, repair = false) { return parseJournal(dir, repair).records; }

function appendBodyUnlocked(dir, record) {
  dir = canonicalDir(dir);
  const state = parseJournal(dir, false);
  if (state.invalid) throw new Error(`journal requires repair before append: ${state.invalid.reason}`);
  if (state.migrationAnchor && !fs.existsSync(paths(dir).migration)) {
    const anchor = { schema: 1, kind: 'migration-anchor', ...state.migrationAnchor, signedHash: hash(state.migrationAnchor), createdAt: new Date().toISOString() };
    const afd = fs.openSync(paths(dir).migration, 'wx'); try { fs.writeSync(afd, JSON.stringify(anchor), null, 'utf8'); fs.fsyncSync(afd); } finally { fs.closeSync(afd); }
  }
  const body = { ...record, seq: state.records.length + 1, epoch: record.epoch || 1, priorHash: state.lastHash, ts: new Date().toISOString() };
  body.recordHash = hash(body);
  appendFileSync(paths(dir).journal, JSON.stringify(body) + '\n');
  return body;
}

function appendUnlocked(dir, record) {
  dir = canonicalDir(dir);
  let state = parseJournal(dir, false);
  if (state.invalid) {
    const raw = fs.readFileSync(paths(dir).journal); const suffix = raw.subarray(state.invalid.offset).toString('utf8'); quarantine(dir, [{ reason: state.invalid.reason, byteOffset: state.invalid.offset, suffixHash: bytesHash(raw.subarray(state.invalid.offset)), suffixBytes: suffix.slice(0, 8192) }]); salvageIngress(dir, suffix);
    const fd = fs.openSync(paths(dir).journal, 'r+'); try { fs.ftruncateSync(fd, state.validBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    state = parseJournal(dir, false);
  }
  const salvageFile = path.join(dir, 'ingress-salvage.ndjson');
  if (fs.existsSync(salvageFile)) {
    const salvageRows = readJsonLines(salvageFile); try { fs.unlinkSync(salvageFile); } catch {}
    for (const row of salvageRows) {
      const existing = parseJournal(dir, false).records.find(r => r.kind === 'ingress' && ((row.idempotencyKey && r.idempotencyKey === row.idempotencyKey) || (row.eventId && (r.eventId === row.eventId || r.directiveId === row.directiveId))));
      if (!existing) appendBodyUnlocked(dir, { kind: 'ingress', eventId: row.eventId || `event:${crypto.randomUUID()}`, directiveId: row.directiveId || row.eventId, idempotencyKey: row.idempotencyKey || null, contentHash: row.contentHash || bytesHash(row.text), source: row.source, text: row.text, createdAt: new Date().toISOString(), salvaged: true });
    }
  }
  return appendBodyUnlocked(dir, record);
}
function append(dir, record) { return withLock(dir, () => appendUnlocked(dir, record)); }

function leaseParts(leaseOrOwner, token, epoch) {
  if (leaseOrOwner && leaseOrOwner.owner) return { owner: `fleethost:${leaseOrOwner.owner.pid}`, token: token || leaseOrOwner.token || leaseOrOwner.owner.token, epoch: epoch || leaseOrOwner.owner.epoch };
  if (leaseOrOwner && leaseOrOwner.pid && leaseOrOwner.token) return { owner: `fleethost:${leaseOrOwner.pid}`, token: token || leaseOrOwner.token, epoch: epoch || leaseOrOwner.epoch };
  if (leaseOrOwner && leaseOrOwner.pid && leaseOrOwner.token) return { owner: `fleethost:${leaseOrOwner.pid}`, token: token || leaseOrOwner.token, epoch: epoch || leaseOrOwner.epoch };
  return { owner: String(leaseOrOwner), token, epoch };
}
function assertLease(root, leaseOrOwner, token, epoch) {
  root = canonicalDir(root);
  const p = path.join(root, 'sidecar-lease.json'); const l = leaseParts(leaseOrOwner, token, epoch); let current;
  try { current = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error('lease missing'); }
  if (current.token !== l.token || Number(current.epoch) !== Number(l.epoch) || current.status === 'released') throw new Error('stale lease fence rejected');
  try { require('./sidecar-lease.cjs').validate(root, l.token, l.epoch); } catch (error) { throw new Error(error.message.includes('lease') ? error.message : 'stale lease fence rejected'); }
  return l;
}

function appendIngress(dir, text, source = 'journal', options = {}) {
  const content = String(text == null ? '' : text); if (!content) throw new Error('empty directive');
  const attachments = options.attachments == null ? null : admitImageAttachments(dir, options.attachments);
  const attachmentsHash = attachments ? hash(attachments) : null;
  return withLock(dir, () => {
    const prior = parseJournal(dir, false).records; const key = options.idempotencyKey == null ? null : String(options.idempotencyKey);
    if (key) { const existing = prior.find(r => r.kind === 'ingress' && r.idempotencyKey === key); if (existing) { const existingAttachmentsHash = existing.attachmentsHash || (existing.attachments ? hash(existing.attachments) : null); if (existing.source !== source || existing.contentHash !== bytesHash(content) || existingAttachmentsHash !== attachmentsHash) { quarantine(dir, [{ reason: 'idempotency-conflict', idempotencyKey: key, existingRecordHash: existing.recordHash, source, contentHash: bytesHash(content), attachmentsHash }]); assert.fail('idempotency key content conflict'); } return existing; } }
    const eventId = options.eventId || (key ? `event:${bytesHash(key)}` : `event:${crypto.randomUUID()}`);
    const sameId = prior.find(r => r.kind === 'ingress' && (r.eventId === eventId || r.directiveId === eventId));
    const sameAttachmentsHash = sameId && (sameId.attachmentsHash || (sameId.attachments ? hash(sameId.attachments) : null));
    if (sameId && (sameId.source !== source || sameId.contentHash !== bytesHash(content) || sameAttachmentsHash !== attachmentsHash)) { quarantine(dir, [{ reason: 'event-id-conflict', eventId, existingRecordHash: sameId.recordHash, source, contentHash: bytesHash(content), attachmentsHash }]); assert.fail('event id content conflict'); }
    if (sameId) return sameId;
    return appendUnlocked(dir, { kind: 'ingress', eventId, directiveId: eventId, idempotencyKey: key, contentHash: bytesHash(content), source, text: content, ...(attachments ? { attachments, attachmentsHash } : {}), createdAt: new Date().toISOString() });
  });
}

function claimFiles(inbox) { return fs.existsSync(path.dirname(inbox)) ? fs.readdirSync(path.dirname(inbox)).filter(name => name.startsWith(path.basename(inbox) + '.claim.')).map(name => path.join(path.dirname(inbox), name)) : []; }
function reconcileLegacy(dir, inbox, source = 'legacy-say-inbox') {
  dir = canonicalDir(dir);
  fs.mkdirSync(path.dirname(inbox), { recursive: true }); let candidates = claimFiles(inbox);
  if (fs.existsSync(inbox)) { const claimPath = `${inbox}.claim.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`; try { fs.renameSync(inbox, claimPath); candidates.push(claimPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  let first = null;
  for (const claimPath of candidates) {
    const text = fs.readFileSync(claimPath, 'utf8'); if (!text) { try { fs.unlinkSync(claimPath); } catch {} continue; }
    const record = appendIngress(dir, text, source, { idempotencyKey: `legacy-claim:${path.basename(claimPath)}` }); first ||= record;
    try { fs.unlinkSync(claimPath); } catch {}
  }
  if (!fs.existsSync(inbox)) { const fd = fs.openSync(inbox, 'a'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  return first;
}

function entries(dir) {
  dir = canonicalDir(dir); const state = parseJournal(dir, false);
  const records = state.invalid?.record ? [...state.records, { ...state.invalid.record, __quarantined: true }] : state.records;
  const byId = new Map();
  for (const record of records) {
    if (!record.eventId && !record.directiveId) continue;
    const id = record.eventId || record.directiveId;
    const item = byId.get(id) || { ingress: null, claims: [], renewals: [], replayLimits: [], replayRecoveries: [], terminal: null, terminalConflicts: [], lateResults: [], adjudications: [] };
    if (record.kind === 'ingress') item.ingress ||= record;
    else if (record.kind === 'claim') item.claims.push(record);
    else if (record.kind === 'claim-renewal') item.renewals.push(record);
    else if (record.kind === 'replay-limit') item.replayLimits.push(record);
    else if (record.kind === 'replay-recovery') item.replayRecoveries.push(record);
    else if (record.kind === 'adjudication' || record.kind === 'supersession') item.adjudications.push(record);
    else if (record.kind === 'ack' || record.kind === 'fail') {
      if (!item.terminal) item.terminal = record;
      else if (item.terminal.blocked && item.replayRecoveries.length) { item.terminalConflicts.push(item.terminal); item.terminal = record; }
      else item.terminalConflicts.push(record);
    } else if (record.kind === 'late-result') item.lateResults.push(record);
    byId.set(id, item);
  }
  for (const item of byId.values()) {
    item.lateResults.push(...item.terminalConflicts.filter(record => record.kind === 'ack' || record.kind === 'fail' && record.resultHash));
  }
  return { records: state.records, byId };
}
function getIngress(dir, eventId) { return entries(dir).byId.get(eventId)?.ingress || null; }
function latestAttempt(item) {
  if (!item) return null;
  const claims = [...item.claims].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  const claim = claims.at(-1); if (!claim) return null;
  const renewals = item.renewals.filter(r => r.attemptId === claim.attemptId).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  return renewals.at(-1) || claim;
}
function activeAttempt(item, now = Date.now()) {
  const attempt = latestAttempt(item);
  if (attempt?.requestedClaimTtlMs === 1) return null;
  return attempt && Number(attempt.expiresAt || 0) > now ? attempt : null;
}
function workerStillAlive(attempt, now = Date.now()) {
  if (!attempt || attempt.requestedClaimTtlMs === 1 || Number(attempt.expiresAt || 0) > now || !attempt.workerPid) return false;
  const staleGraceMs = Math.max(30_000, Number(attempt.effectiveClaimTtlMs || attempt.requestedClaimTtlMs || 30_000) * 2);
  if (now - Number(attempt.expiresAt || 0) > staleGraceMs) return false;
  try { process.kill(Number(attempt.workerPid), 0); return true; } catch { return false; }
}
function authoritativeTerminalFromItem(item, eventId) {
  if (!item?.terminal) return null;
  if (item.terminal.blocked && item.replayRecoveries.length) return null;
  let result = item.terminal;
  for (const adjudication of item.adjudications.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))) {
    if (adjudication.rejectedTerminalHash === result.recordHash && adjudication.replacementTerminalHash) {
      const replacement = [...item.terminalConflicts, ...item.lateResults].find(r => r.recordHash === adjudication.replacementTerminalHash);
      const proofMatches = adjudication.proof?.eventId === eventId && (adjudication.proof?.replacementAttemptId === replacement.attemptId || (replacement.attemptId == null && adjudication.proof?.legacyFossil === true && adjudication.proof?.replacementResultHash === replacement.resultHash));
      if (replacement && proofMatches) result = replacement;
    }
  }
  return result;
}
function authoritativeTerminal(dir, eventId) {
  return authoritativeTerminalFromItem(entries(dir).byId.get(eventId), eventId);
}
function terminal(dir, eventId) { return authoritativeTerminal(dir, eventId); }

function operatorIngress(item) {
  const source = String(item?.ingress?.source || '').toLowerCase();
  return source === 'ipc-say' || source === 'legacy-say-inbox' || source === 'daniel';
}

function claimNext(dir, leaseOrOwner, epoch, token, claimTtlMs = 30000, maxReplays = 3, attemptMeta = {}) {
  const ttl = admitClaimTtl(claimTtlMs);
  dir = canonicalDir(dir);
  return withLock(dir, () => {
    const l = leaseParts(leaseOrOwner, token, epoch); assertLease(dir, leaseOrOwner, token, epoch); const snapshot = entries(dir); const now = Date.now();
    const allowOperator = attemptMeta.allowOperator !== false;
    const allowBackground = attemptMeta.allowBackground !== false;
    const eligible = [...snapshot.byId.values()].filter(item => item.ingress && (operatorIngress(item) ? allowOperator : allowBackground) && (!item.terminal || (item.terminal.blocked && item.replayRecoveries.length)) && (!item.replayLimits.length || (item.terminal?.blocked && item.replayRecoveries.length)) && !activeAttempt(item, now) && !workerStillAlive(latestAttempt(item), now));
    eligible.sort((a, b) => Number(operatorIngress(b)) - Number(operatorIngress(a)) || Number(a.ingress.seq || 0) - Number(b.ingress.seq || 0));
    const candidate = eligible[0]; if (!candidate) return null;
    const priorClaim = candidate.claims[candidate.claims.length - 1];
    if (candidate.claims.length >= maxReplays && !candidate.replayRecoveries.length) {
      const prior = candidate.claims.at(-1); appendUnlocked(dir, { kind: 'fail', eventId: candidate.ingress.eventId || candidate.ingress.directiveId, directiveId: candidate.ingress.directiveId,
        reason: `replay-limit-${maxReplays}`, blocked: true, recoverable: true, executionPath: 'deterministic-control', parserRule: 'claimNext replay limit',
        attemptId: prior?.attemptId || null, claimRecordHash: prior?.recordHash || null, contentHash: candidate.ingress.contentHash,
        workerPid: prior?.workerPid || null, workerStartIdentity: prior?.workerStartIdentity || null, providerSessionId: prior?.providerSessionId || null, providerModel: prior?.providerModel || null,
        owner: l.owner, token: l.token, epoch: l.epoch, replayCount: candidate.claims.length }); return null;
    }
    const eventId = candidate.ingress.eventId || candidate.ingress.directiveId;
    return appendUnlocked(dir, { kind: 'claim', eventId, directiveId: candidate.ingress.directiveId, contentHash: candidate.ingress.contentHash,
      attemptId: `attempt:${crypto.randomUUID()}`, owner: l.owner, token: l.token, tokenFingerprint: bytesHash(l.token).slice(-16), epoch: l.epoch,
      workerPid: attemptMeta.workerPid || process.pid, workerStartIdentity: attemptMeta.workerStartIdentity || null,
      providerSessionId: attemptMeta.providerSessionId || null, providerModel: attemptMeta.providerModel || null,
      lane: attemptMeta.lane || (operatorIngress(candidate) ? 'mouth' : 'metabolism'),
      ...ttl, expiresAt: now + ttl.effectiveClaimTtlMs, replay: Boolean(priorClaim), claimCount: candidate.claims.length + 1 });
  });
}

function renewClaim(dir, eventId, attempt, leaseOrOwner, epoch, token, claimTtlMs = 30000) {
  const ttl = admitClaimTtl(claimTtlMs);
  return withLock(dir, () => {
    const l = assertLease(dir, leaseOrOwner, token, epoch); const item = entries(dir).byId.get(eventId); const current = latestAttempt(item);
    const claim = item?.claims?.find(record => record.attemptId === attempt.attemptId && record.recordHash === attempt.claimRecordHash);
    if (!claim || !current || current.attemptId !== claim.attemptId || claim.contentHash !== attempt.contentHash || current.contentHash !== attempt.contentHash) throw new Error('claim renewal authority mismatch');
    return appendUnlocked(dir, { kind: 'claim-renewal', eventId, directiveId: item.ingress.directiveId, attemptId: claim.attemptId, claimRecordHash: claim.recordHash,
      contentHash: claim.contentHash, owner: l.owner, token: l.token, tokenFingerprint: bytesHash(l.token).slice(-16), epoch: l.epoch,
      workerPid: attempt.workerPid, workerStartIdentity: attempt.workerStartIdentity, providerSessionId: attempt.providerSessionId, providerModel: attempt.providerModel,
      lane: attempt.lane || claim.lane || null,
      ...ttl, expiresAt: Date.now() + ttl.effectiveClaimTtlMs });
  });
}

function repairReplayLimit(dir, eventId, reason, leaseOrOwner, epoch, token) {
  return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const item = entries(dir).byId.get(eventId); if (!item?.terminal?.blocked && !item?.replayLimits?.length) throw new Error('no replay-limit state');
    if (!item.terminal?.blocked) appendUnlocked(dir, { kind: 'fail', eventId, directiveId: item.ingress.directiveId, reason: String(reason || 'replay-limit-migrated'), blocked: true, recoverable: true, executionPath: 'deterministic-control', parserRule: 'replay-limit migration repair', contentHash: item.ingress.contentHash, replayCount: item.claims.length, owner: l.owner, token: l.token, epoch: l.epoch });
    const repaired = entries(dir).byId.get(eventId); if (repaired.replayRecoveries.length) return repaired.replayRecoveries.at(-1);
    return appendUnlocked(dir, { kind: 'replay-recovery', eventId, directiveId: item.ingress.directiveId, reason: String(reason || 'operator-recovery'), blockedRecordHash: repaired.terminal.recordHash, owner: l.owner, token: l.token, epoch: l.epoch });
  });
}

function validateAttempt(item, eventId, extra, kind) {
  const claim = item && item.claims.find(c => c.attemptId === extra.attemptId && c.recordHash === extra.claimRecordHash);
  const attempt = latestAttempt(item);
  if (!claim || !attempt || attempt.attemptId !== claim.attemptId || claim.contentHash !== item.ingress.contentHash || attempt.contentHash !== item.ingress.contentHash || extra.contentHash !== item.ingress.contentHash) throw new Error('terminal attempt/content authority mismatch');
  if (extra.workerPid != null && Number(extra.workerPid) !== Number(attempt.workerPid)) throw new Error('terminal worker pid mismatch');
  if (extra.workerStartIdentity && extra.workerStartIdentity !== attempt.workerStartIdentity) throw new Error('terminal process identity mismatch');
  if (extra.executionPath === 'model' && (!extra.providerModel || !attempt.providerModel)) throw new Error('model terminal missing provider authority');
  if (!['model', 'deterministic-control', 'repair', 'operator-cancel'].includes(extra.executionPath)) throw new Error('terminal executionPath required');
  if (extra.executionPath === 'deterministic-control' && !extra.parserRule) throw new Error('deterministic control requires parserRule');
  return attempt;
}
function terminalAppend(dir, kind, eventId, result, leaseOrOwner, epoch, token, extra = {}) { return withLock(dir, () => {
  const l = assertLease(dir, leaseOrOwner, token, epoch); const snapshot = entries(dir); const item = snapshot.byId.get(eventId); if (!item?.ingress) throw new Error('unknown ingress event');
  const existing = authoritativeTerminal(dir, eventId);
  let attempt = null;
  if (extra.executionPath === 'repair') { if (!extra.repairProof) throw new Error('repair terminal requires repairProof'); }
  else attempt = validateAttempt(item, eventId, extra, kind);
  if (attempt && Number(attempt.epoch) !== Number(l.epoch)) throw new Error('terminal epoch no longer current');
  if (attempt && extra.tokenFingerprint && extra.tokenFingerprint !== attempt.tokenFingerprint) throw new Error('terminal token fingerprint mismatch');
  if (attempt && extra.executionPath === 'model' && (!extra.workerStartIdentity || extra.workerStartIdentity !== attempt.workerStartIdentity)) throw new Error('model process identity required');
  if (existing) {
    const conflict = appendUnlocked(dir, { kind: 'terminal-conflict', eventId, directiveId: eventId, firstTerminalHash: existing.recordHash, attemptedKind: kind,
      attemptId: extra.attemptId || null, resultHash: bytesHash(result), executionPath: extra.executionPath || null, owner: l.owner, token: l.token, epoch: l.epoch });
    if (kind === 'ack') appendUnlocked(dir, { kind: 'late-result', eventId, directiveId: eventId, resultHash: bytesHash(result), result: String(result), firstTerminalHash: existing.recordHash,
      attemptId: extra.attemptId || null, claimRecordHash: extra.claimRecordHash || null, contentHash: extra.contentHash || null, executionPath: extra.executionPath || null,
      workerPid: extra.workerPid || null, workerStartIdentity: extra.workerStartIdentity || null, providerSessionId: extra.providerSessionId || null, providerModel: extra.providerModel || null,
      owner: l.owner, token: l.token, epoch: l.epoch });
    return { ...existing, conflictRecordHash: conflict.recordHash };
  }
  let canonical; try { canonical = JSON.parse(String(result)); } catch { canonical = { reply: String(result) }; }
  return appendUnlocked(dir, { ...extra, kind, eventId, directiveId: eventId, resultHash: bytesHash(result), result: String(result), publication: { reply: canonical.reply ?? null, error: canonical.error ?? null, control: canonical.control ?? null },
    owner: l.owner, token: l.token, epoch: l.epoch, attemptId: extra.attemptId, claimRecordHash: extra.claimRecordHash, contentHash: extra.contentHash,
    executionPath: extra.executionPath, parserRule: extra.parserRule || null, workerPid: extra.workerPid || attempt?.workerPid || null, workerStartIdentity: extra.workerStartIdentity || attempt?.workerStartIdentity || null,
    providerSessionId: extra.providerSessionId || attempt?.providerSessionId || null, providerModel: extra.providerModel || attempt?.providerModel || null });
}); }
function ack(dir, eventId, result, leaseOrOwner, epoch, token, extra = {}) { return terminalAppend(dir, 'ack', eventId, result, leaseOrOwner, epoch, token, extra); }
function fail(dir, eventId, reason, leaseOrOwner, epoch, token, extra = {}) { return terminalAppend(dir, 'fail', eventId, JSON.stringify({ error: String(reason) }), leaseOrOwner, epoch, token, { ...extra, reason: String(reason) }); }

function adjudicateTerminal(dir, eventId, rejectedTerminalHash, replacementTerminalHash, proof, leaseOrOwner, epoch, token) {
  return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const snapshot = entries(dir); const item = snapshot.byId.get(eventId);
    if (!item?.terminal || item.terminal.recordHash !== rejectedTerminalHash) throw new Error('adjudication rejected terminal mismatch');
    if (proof?.firstTerminalInvalid !== true && proof?.legacyFossil !== true) throw new Error('adjudication requires invalid-terminal proof');
    const replacement = [...item.terminalConflicts, ...item.lateResults].find(r => r.recordHash === replacementTerminalHash);
    const replacementProofOk = replacement && replacement.eventId === eventId && proof?.eventId === eventId && (proof?.replacementAttemptId === replacement.attemptId || (replacement.attemptId == null && proof?.legacyFossil === true && proof?.replacementResultHash === replacement.resultHash));
    if (!replacementProofOk) throw new Error('adjudication causal proof mismatch');
    return appendUnlocked(dir, { kind: 'adjudication', eventId, directiveId: eventId, rejectedTerminalHash, replacementTerminalHash, proof, owner: l.owner, token: l.token, epoch: l.epoch });
  });
}

function outboxFailure(message, code, cause = null) {
  const error = new Error(message);
  error.name = 'OutboxPublicationError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
function outboxResultHash(entry) { return entry.resultHash || bytesHash(entry.reply || entry.error || JSON.stringify(entry)); }
function authoritativeOutboxMap(rows) {
  const current = new Map();
  for (const row of rows || []) {
    if (!row?.directiveId || !row.recordHash) continue;
    const prior = current.get(row.directiveId);
    if (!prior) {
      // A supersession without its referenced predecessor is not independently
      // authoritative. Ignore it deterministically rather than laundering it.
      if (!row.supersedesOutboxRecordHash) current.set(row.directiveId, row);
      continue;
    }
    if (row.supersedesOutboxRecordHash === prior.recordHash) current.set(row.directiveId, row);
    // Legacy duplicate/fork rows do not displace the first admitted projection.
  }
  return current;
}
function readOutbox(file) { return [...authoritativeOutboxMap(readJsonLines(file)).values()]; }
function appendOutbox(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let rows;
    try { rows = readJsonLines(file); }
    catch {
      const raw = fs.readFileSync(file); const boundary = raw.lastIndexOf(0x0a);
      appendFileSync(`${file}.quarantine`, JSON.stringify({ reason: 'outbox-corrupt-tail', suffixHash: bytesHash(raw.subarray(Math.max(0, boundary + 1))) }) + '\n');
      const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, Math.max(0, boundary + 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      rows = readJsonLines(file);
    }
    const resultHash = outboxResultHash(entry);
    if (entry.directiveId) {
      const current = authoritativeOutboxMap(rows).get(entry.directiveId);
      if (current) {
        if (!entry.supersedesOutboxRecordHash && resultHash === current.resultHash) return current;
        if (entry.supersedesOutboxRecordHash !== current.recordHash) throw outboxFailure('outbox result conflict for event', 'OUTBOX_RESULT_CONFLICT');
        if (!entry.authoritativeTerminalRecordHash || !entry.supersessionReason) throw outboxFailure('outbox supersession requires authoritative terminal proof', 'OUTBOX_SUPERSESSION_PROOF_REQUIRED');
      } else if (entry.supersedesOutboxRecordHash) {
        throw outboxFailure('outbox supersession target is unavailable', 'OUTBOX_SUPERSESSION_TARGET_MISSING');
      }
    }
    const body = { ...entry, resultHash, ts: new Date().toISOString() };
    body.recordHash = hash(body);
    appendFileSync(file, JSON.stringify(body) + '\n');
    return body;
  } catch (error) {
    if (error?.name === 'OutboxPublicationError') throw error;
    throw outboxFailure(`outbox publication failed: ${String(error?.message || error)}`, 'OUTBOX_PUBLICATION_FAILED', error);
  }
}
function publicationFromTerminal(record) {
  return record.publication || (() => {
    try { const parsed = JSON.parse(record.result); return { reply: parsed.reply ?? null, error: parsed.error ?? null, control: parsed.control ?? null }; }
    catch { return { reply: record.result, error: null, control: null }; }
  })();
}
function samePublication(row, publication) {
  return (row.reply ?? null) === (publication.reply ?? null)
    && (row.error ?? null) === (publication.error ?? null)
    && (row.control ?? null) === (publication.control ?? null);
}
function repairPublication(dir, outboxFile, leaseOrOwner, epoch, token) {
  dir = canonicalDir(dir);
  let rows = []; try { rows = readJsonLines(outboxFile); } catch {}
  const snapshot = entries(dir);
  const published = authoritativeOutboxMap(rows);
  const repaired = [];
  for (const row of published.values()) {
    if (!row.directiveId || authoritativeTerminalFromItem(snapshot.byId.get(row.directiveId), row.directiveId)) continue;
    const repairMeta = { executionPath: 'repair', repairProof: { outboxRecordHash: row.recordHash }, repairedFromOutbox: true, outboxRecordHash: row.recordHash };
    repaired.push(row.error != null
      ? fail(dir, row.directiveId, String(row.error), leaseOrOwner, epoch, token, repairMeta)
      : ack(dir, row.directiveId, JSON.stringify({ reply: row.reply ?? null, error: null, control: row.control ?? null }), leaseOrOwner, epoch, token, repairMeta));
  }
  for (const [directiveId, item] of snapshot.byId) {
    const record = authoritativeTerminalFromItem(item, directiveId);
    if (!record || !['ack', 'fail', 'late-result'].includes(record.kind) || !record.result) continue;
    const publication = publicationFromTerminal(record);
    const current = published.get(directiveId);
    if (current && samePublication(current, publication)) continue;
    const logicalKind = record.kind === 'late-result' ? 'ack' : record.kind;
    const appended = appendOutbox(outboxFile, {
      directiveId,
      ...publication,
      resultHash: record.resultHash,
      repairedFromTerminal: logicalKind,
      authoritativeTerminalRecordHash: record.recordHash,
      ...(current ? { supersedesOutboxRecordHash: current.recordHash, supersessionReason: 'authoritative-terminal-changed' } : {}),
    });
    published.set(directiveId, appended);
  }
  return repaired;
}
function telemetry(dir) {
  dir = canonicalDir(dir);
  const snapshot = entries(dir); const now = Date.now(); const pending = [...snapshot.byId.values()].filter(item => item.ingress && !item.terminal);
  const claims = pending.flatMap(item => item.claims); const active = pending.map(item => activeAttempt(item, now)).filter(Boolean);
  return { journalDepth: snapshot.records.length, queueDepth: pending.length, oldestAgeMs: pending.length ? Math.max(0, now - Date.parse(pending[0].ingress.createdAt || now)) : 0, activeClaimExpiry: active.length ? Math.min(...active.map(claim => claim.expiresAt)) : null, replayCount: claims.filter(claim => claim.replay).length, renewalCount: pending.reduce((n, item) => n + item.renewals.length, 0), quarantineBytes: fs.existsSync(paths(dir).quarantine) ? fs.statSync(paths(dir).quarantine).size : 0 };
}
function appendError(dir, error, context = {}) { return append(canonicalDir(dir), { kind: 'sidecar-error', error: String(error?.stack || error), context }); }

module.exports = { hash, bytesHash, imageHash, canonicalDir, paths, withLock, readJournal, append, appendIngress, reconcileLegacy, claimNext, renewClaim, repairReplayLimit, adjudicateTerminal, authoritativeTerminal, getIngress, entries, terminal, ack, fail, appendOutbox, readOutbox, repairPublication, telemetry, appendError, claimFiles, assertLease, salvageIngress, persistImageDataUrls, readImageAttachment, admitImageAttachments, removeImageAttachments, sweepImageAttachments, IMAGE_COUNT_LIMIT, IMAGE_BYTES_LIMIT, IMAGE_TOTAL_BYTES_LIMIT, IMAGE_DIMENSION_LIMIT, IMAGE_PIXEL_LIMIT, IMAGE_TOTAL_PIXEL_LIMIT };
