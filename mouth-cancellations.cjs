'use strict';

// Durable pre-admission cancellation ledger.  A renderer can ask to stop a
// mouth submission before the sidecar has attached an AbortController; this
// ledger closes that temporal gap without treating a Set in one process as
// durable truth.  Records are append-only and chained.  A consumption receipt
// is never deleted, so a restarted sidecar can distinguish a fresh request
// from a cancellation that was already applied.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const ID_MAX_LENGTH = 192;
const LOCK_STALE_MS = 60_000;
const LOCK_ATTEMPTS = 2_000;
const LOCK_RETRY_MS = 5;

function canonicalRoot(root) {
  return path.resolve(root || path.join(__dirname, '.atlas'));
}

function paths(root) {
  const dir = canonicalRoot(root);
  return {
    root: dir,
    ledger: path.join(dir, 'mouth-cancellations.ndjson'),
    lock: path.join(dir, 'mouth-cancellations.lock'),
  };
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeSubmissionId(value) {
  const submissionId = String(value == null ? '' : value).trim();
  if (!submissionId || submissionId.length > ID_MAX_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(submissionId)) {
    throw new Error(`submissionId must match [A-Za-z0-9][A-Za-z0-9._:-]* and be at most ${ID_MAX_LENGTH} characters`);
  }
  return submissionId;
}

function optionalText(value, label, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`);
  return text || null;
}

function sleep(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

function withLock(root, fn) {
  const p = paths(root);
  fs.mkdirSync(p.root, { recursive: true });
  let fd = null;
  const owner = { pid: process.pid, token: crypto.randomBytes(12).toString('hex'), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(p.lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(owner), null, 'utf8');
      fs.fsyncSync(fd);
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
      try {
        const stat = fs.statSync(p.lock);
        const holder = JSON.parse(fs.readFileSync(p.lock, 'utf8'));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS || !processAlive(holder?.pid)) fs.unlinkSync(p.lock);
      } catch {}
      sleep(LOCK_RETRY_MS);
    }
  }
  if (fd == null) throw new Error('mouth cancellation ledger lock timeout');
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(p.lock); } catch {}
  }
}

function readRecords(root) {
  const p = paths(root);
  if (!fs.existsSync(p.ledger)) return [];
  const raw = fs.readFileSync(p.ledger, 'utf8');
  if (raw && !raw.endsWith('\n')) throw new Error('mouth cancellation ledger has an incomplete tail');
  const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`mouth cancellation ledger has invalid JSON at line ${index + 1}`); }
  });
  let priorHash = null;
  const state = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.schema !== SCHEMA || row.seq !== index + 1 || row.priorHash !== priorHash || typeof row.recordHash !== 'string') {
      throw new Error(`mouth cancellation ledger chain invalid at sequence ${index + 1}`);
    }
    const unsigned = { ...row };
    delete unsigned.recordHash;
    if (row.recordHash !== hash(unsigned)) throw new Error(`mouth cancellation ledger hash invalid at sequence ${index + 1}`);
    const submissionId = normalizeSubmissionId(row.submissionId);
    if (!['request', 'consume'].includes(row.kind)) throw new Error(`mouth cancellation ledger kind invalid at sequence ${index + 1}`);
    const prior = state.get(submissionId) || { request: null, consumption: null };
    if (row.kind === 'request') {
      if (prior.request) throw new Error(`mouth cancellation ledger has duplicate request for ${submissionId}`);
      prior.request = row;
    } else {
      if (!prior.request || prior.consumption || row.requestRecordHash !== prior.request.recordHash) {
        throw new Error(`mouth cancellation ledger consume causality invalid at sequence ${index + 1}`);
      }
      prior.consumption = row;
    }
    state.set(submissionId, prior);
    priorHash = row.recordHash;
  }
  return rows;
}

function stateFor(records, submissionId) {
  const related = records.filter(record => record.submissionId === submissionId);
  const request = related.find(record => record.kind === 'request') || null;
  const consumption = related.find(record => record.kind === 'consume') || null;
  return Object.freeze({
    submissionId,
    requested: Boolean(request),
    consumed: Boolean(consumption),
    request,
    consumption,
    records: Object.freeze(related.slice()),
  });
}

function appendUnlocked(root, record) {
  const p = paths(root);
  const records = readRecords(p.root);
  const body = {
    schema: SCHEMA,
    seq: records.length + 1,
    priorHash: records.at(-1)?.recordHash || null,
    ts: new Date().toISOString(),
    ...record,
  };
  body.recordHash = hash(body);
  const fd = fs.openSync(p.ledger, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fsyncDirectory(p.root);
  return Object.freeze(body);
}

function request(root, submissionId, options = {}) {
  submissionId = normalizeSubmissionId(submissionId);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('request options must be an object');
  const requestedBy = optionalText(options.requestedBy, 'requestedBy', 128) || `pid:${process.pid}`;
  const reason = optionalText(options.reason, 'reason', 240);
  return withLock(root, () => {
    const current = stateFor(readRecords(root), submissionId);
    if (current.request) return Object.freeze({ outcome: 'existing', ...current });
    const receipt = appendUnlocked(root, { kind: 'request', submissionId, requestedBy, reason });
    return Object.freeze({ outcome: 'requested', ...stateFor(readRecords(root), submissionId), receipt });
  });
}

function query(root, submissionId) {
  submissionId = normalizeSubmissionId(submissionId);
  return stateFor(readRecords(root), submissionId);
}

// Atomically claims a requested cancellation for one admission attempt.  A
// later caller observes the original consume receipt rather than deleting it
// or creating a competing terminal state.
function consumeOrObserve(root, submissionId, options = {}) {
  submissionId = normalizeSubmissionId(submissionId);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('consume options must be an object');
  const consumer = optionalText(options.consumer, 'consumer', 128) || `pid:${process.pid}`;
  const phase = optionalText(options.phase, 'phase', 80) || 'pre-admission';
  return withLock(root, () => {
    const current = stateFor(readRecords(root), submissionId);
    if (!current.request) return Object.freeze({ outcome: 'absent', ...current });
    if (current.consumption) return Object.freeze({ outcome: 'observed', ...current });
    const receipt = appendUnlocked(root, {
      kind: 'consume',
      submissionId,
      requestRecordHash: current.request.recordHash,
      consumer,
      phase,
    });
    return Object.freeze({ outcome: 'consumed', ...stateFor(readRecords(root), submissionId), receipt });
  });
}

module.exports = {
  SCHEMA,
  ID_MAX_LENGTH,
  canonicalRoot,
  paths,
  hash,
  normalizeSubmissionId,
  readRecords,
  request,
  query,
  consumeOrObserve,
};
