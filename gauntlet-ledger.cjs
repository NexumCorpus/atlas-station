'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonical, digest, normalize } = require('./gauntlet-protocol.cjs');
const appendLock = require('./append-lock.cjs');

const MAX_RECORDS = 10_000;
const MAX_LINE_BYTES = 1_048_576;

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, 'utf8');
  if (!text.trim()) return [];
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length > MAX_RECORDS) throw new Error(`GAUNTLET ledger exceeds ${MAX_RECORDS} records`);
  return lines.map((line, index) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`GAUNTLET ledger line ${index + 1} exceeds byte limit`);
    try { return JSON.parse(line); } catch { throw new Error(`GAUNTLET ledger line ${index + 1} is invalid JSON`); }
  });
}

function verifyLedger(ledgerPath) {
  const records = readLedger(ledgerPath);
  let priorHash = 'GENESIS';
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.seq !== index + 1 || record.priorHash !== priorHash) throw new Error(`GAUNTLET ledger linkage failure at record ${index + 1}`);
    const { recordHash, ...core } = record;
    if (recordHash !== digest(core)) throw new Error(`GAUNTLET ledger hash failure at record ${index + 1}`);
    priorHash = recordHash;
  }
  return { valid: true, count: records.length, head: priorHash, records };
}

function appendRecord(ledgerPath, kind, payload, ts = new Date().toISOString()) {
  if (!/^(FROZEN|WITNESSED|SEEDED|RUN|SETTLED|SUPERSEDED)$/.test(kind)) throw new Error(`invalid GAUNTLET record kind: ${kind}`);
  const dir = path.dirname(path.resolve(ledgerPath));
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${ledgerPath}.lock`;
  let lock;
  try {
    lock = appendLock.acquire(lockPath);
    const verified = verifyLedger(ledgerPath);
    if (verified.count >= MAX_RECORDS) throw new Error(`GAUNTLET ledger cannot exceed ${MAX_RECORDS} records`);
    if (payload?.state !== kind) throw new Error(`GAUNTLET ${kind} payload state mismatch`);
    const freezeDigest = payload?.freezeDigest;
    if (!/^[a-f0-9]{64}$/.test(freezeDigest || '')) throw new Error(`GAUNTLET ${kind} requires a freeze digest`);
    const claim = verified.records.filter(record => record.payload?.freezeDigest === freezeDigest);
    const order = ['FROZEN', 'WITNESSED', 'SEEDED', 'RUN', 'SETTLED', 'SUPERSEDED'];
    if (kind === 'FROZEN') {
      if (claim.length) throw new Error('GAUNTLET freeze digest already exists');
    } else {
      const expected = order[order.indexOf(kind) - 1];
      if (claim.at(-1)?.kind !== expected) throw new Error(`GAUNTLET ${kind} requires prior ${expected}`);
    }
    const core = normalize({ schema: 1, seq: verified.count + 1, priorHash: verified.head, ts, kind, payload });
    const record = { ...core, recordHash: digest(core) };
    const line = `${canonical(record)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('GAUNTLET record exceeds byte limit');
    const fd = fs.openSync(ledgerPath, 'a', 0o600);
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return record;
  } finally {
    appendLock.release(lockPath, lock);
  }
}

function projection(ledgerPath) {
  const verified = verifyLedger(ledgerPath);
  const claims = new Map();
  const settlementRoots = new Map(verified.records.filter(record => record.kind === 'SETTLED').map(record => [record.payload?.settlementHash, record.payload?.freezeDigest]));
  for (const record of verified.records) {
    const key = record.payload?.freezeDigest || settlementRoots.get(record.payload?.settlementHash) || record.payload?.settlementHash || record.recordHash;
    const current = claims.get(key) || { freezeDigest: key, states: [] };
    current.states.push({ kind: record.kind, seq: record.seq, recordHash: record.recordHash, ts: record.ts });
    current.current = record.kind;
    current.claimCeiling = record.payload?.claimCeiling || current.claimCeiling || null;
    claims.set(key, current);
  }
  return { schema: 1, valid: verified.valid, count: verified.count, head: verified.head, claims: [...claims.values()] };
}

module.exports = { readLedger, verifyLedger, appendRecord, projection };
