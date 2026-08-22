'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appendLock = require('./append-lock.cjs');

const DEFAULT_LEDGER = path.join(__dirname, 'memory', 'skill-fitness.ndjson');
const MAX_RECORDS = 100_000;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function read(ledgerPath = DEFAULT_LEDGER) {
  if (!fs.existsSync(ledgerPath)) return [];
  if (fs.statSync(ledgerPath).size > MAX_LEDGER_BYTES) throw new Error('skill fitness ledger exceeds byte limit');
  return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    if (Buffer.byteLength(line) > 65_536) throw new Error('skill fitness record exceeds 65536 bytes');
    return JSON.parse(line);
  });
}

function verify(ledgerPath = DEFAULT_LEDGER) {
  const rows = read(ledgerPath);
  if (rows.length > MAX_RECORDS) throw new Error('skill fitness ledger exceeds record limit');
  let priorHash = '0'.repeat(64);
  rows.forEach((row, index) => {
    const unsigned = { ...row }; delete unsigned.recordHash;
    if (row.seq !== index + 1 || row.priorHash !== priorHash || row.recordHash !== sha(JSON.stringify(canonical(unsigned)))) throw new Error(`skill fitness ledger tamper at sequence ${index + 1}`);
    priorHash = row.recordHash;
  });
  return rows;
}

function append(kind, body, ledgerPath = DEFAULT_LEDGER) {
  if (!['selection', 'outcome', 'variant-staged', 'variant-admitted', 'variant-rejected'].includes(kind)) throw new Error('invalid skill fitness record kind');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lockPath = `${ledgerPath}.lock`;
  let lock;
  try {
    lock = appendLock.acquire(lockPath);
    const rows = verify(ledgerPath);
    if (rows.length >= MAX_RECORDS) throw new Error('skill fitness ledger cannot exceed record limit');
    const priorHash = rows.at(-1)?.recordHash || '0'.repeat(64);
    const row = { schema: 1, seq: rows.length + 1, priorHash, kind, ts: new Date().toISOString(), ...canonical(body) };
    row.recordHash = sha(JSON.stringify(canonical(row)));
    if (Buffer.byteLength(JSON.stringify(row)) > 65_536) throw new Error('skill fitness record exceeds 65536 bytes');
    const fd = fs.openSync(ledgerPath, 'a');
    try { fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return row;
  } finally {
    appendLock.release(lockPath, lock);
  }
}

function recordSelection(receipt, ledgerPath) {
  if (!receipt || !Array.isArray(receipt.selected) || receipt.selected.length > 8 || !/^[a-f0-9]{64}$/.test(receipt.taskHash || '') || !/^[a-f0-9]{64}$/.test(receipt.indexHash || '')) throw new Error('invalid skill selection receipt');
  return append('selection', { taskHash: receipt.taskHash, indexHash: receipt.indexHash, selected: receipt.selected, tokenEstimate: receipt.tokenEstimate }, ledgerPath);
}

function recordOutcome(input, ledgerPath) {
  if (!input || !Array.isArray(input.skills) || !input.skills.length || input.skills.length > 8 || input.skills.some(name => !/^atlas-[a-z0-9-]{2,50}$/.test(name))) throw new Error('outcome requires 1 through 8 valid Atlas skills');
  if (!input.evidence || !/^[a-f0-9]{64}$/.test(input.evidence.hash) || typeof input.evidence.id !== 'string' || !input.evidence.id || input.evidence.id.length > 256 || !Number.isFinite(Date.parse(input.evidence.ts))) throw new Error('outcome requires external evidence id, hash, and timestamp');
  if (!['survived', 'failed', 'superseded'].includes(input.verdict)) throw new Error('invalid outcome verdict');
  const rows = verify(ledgerPath);
  const selection = rows.find(row => row.kind === 'selection' && row.recordHash === input.selectionRecordHash);
  if (!selection) throw new Error('outcome requires a prior selection record hash');
  const selectedNames = new Set(selection.selected.map(skill => skill.name));
  if (input.skills.some(name => !selectedNames.has(name))) throw new Error('outcome skills must belong to the referenced selection');
  const evidencePath = path.resolve(input.evidence.path || '');
  const relative = path.relative(__dirname, evidencePath);
  if (!input.evidence.path || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(evidencePath)) throw new Error('outcome evidence must be an existing Atlas repository artifact');
  if (sha(fs.readFileSync(evidencePath)) !== input.evidence.hash) throw new Error('outcome evidence hash mismatch');
  if (Date.parse(input.evidence.ts) < Date.parse(selection.ts) || Date.parse(input.evidence.ts) > Date.now() + 300_000) throw new Error('outcome evidence timestamp is outside the selection window');
  const observedValue = Number(input.observedValue || 0);
  const durationMs = Number(input.durationMs || 0);
  const contextTokens = Number(input.contextTokens || 0);
  if (!Number.isFinite(observedValue) || Math.abs(observedValue) > 1e12) throw new Error('observedValue must be finite and bounded');
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 1e9 || !Number.isInteger(contextTokens) || contextTokens < 0 || contextTokens > 1e9) throw new Error('durationMs and contextTokens must be bounded non-negative integers');
  return append('outcome', { selectionRecordHash: selection.recordHash, skills: [...new Set(input.skills)].sort(), verdict: input.verdict, reportedValue: observedValue, durationMs, contextTokens, evidence: { ...input.evidence, path: relative.replaceAll('\\', '/') }, evidenceStatus: 'hash-bound-local' }, ledgerPath);
}

function project(ledgerPath = DEFAULT_LEDGER) {
  const rows = verify(ledgerPath);
  const fitness = {};
  for (const row of rows.filter(item => item.kind === 'outcome')) for (const name of row.skills) {
    const item = fitness[name] ||= { invocations: 0, survived: 0, failed: 0, superseded: 0, reportedValue: 0, verifiedValue: 0, contextTokens: 0, durationMs: 0 };
    item.invocations += 1; item[row.verdict] += 1; item.reportedValue += row.reportedValue / row.skills.length; item.contextTokens += row.contextTokens / row.skills.length; item.durationMs += row.durationMs / row.skills.length;
  }
  for (const item of Object.values(fitness)) item.reportedValuePerKToken = item.contextTokens ? item.reportedValue * 1000 / item.contextTokens : null;
  return { schema: 1, verifiedRecords: rows.length, fitness };
}

module.exports = { DEFAULT_LEDGER, append, project, read, recordOutcome, recordSelection, verify };
