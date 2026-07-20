'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function bytesHash(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function hash(value) { return bytesHash(JSON.stringify(value)); }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function paths(dir) { return { journal: path.join(dir, 'ingress.ndjson'), quarantine: path.join(dir, 'ingress-quarantine.ndjson'), lock: path.join(dir, 'ingress.lock'), errors: path.join(dir, 'sidecar-errors.ndjson') }; }
function readJsonLines(file) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map(line => JSON.parse(line)); }
function appendFileSync(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, body, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

function withLock(dir, fn) {
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

function parseJournal(dir, repair = true) {
  const file = paths(dir).journal; if (!fs.existsSync(file)) return { records: [], lastHash: null, validBytes: 0 };
  const raw = fs.readFileSync(file); const records = []; let offset = 0; let expectedSeq = 1; let priorHash = null; let invalid = null;
  while (offset < raw.length) {
    const end = raw.indexOf(0x0a, offset); if (end < 0) { invalid = { offset, reason: 'torn-tail', bytes: raw.subarray(offset).toString('utf8') }; break; }
    const lineBytes = raw.subarray(offset, end); const text = lineBytes.toString('utf8'); let record;
    try { record = JSON.parse(text); } catch { invalid = { offset, reason: 'invalid-json', bytes: text }; break; }
    const expectedHash = record.recordHash; const copy = { ...record }; delete copy.recordHash;
    const hashOk = expectedHash === hash(copy);
    const seqOk = Number(record.seq) === expectedSeq;
    const chainOk = record.priorHash == null || record.priorHash === priorHash;
    if (!hashOk || !seqOk || !chainOk) { invalid = { offset, reason: !hashOk ? 'record-hash-mismatch' : !seqOk ? 'sequence-gap' : 'prior-hash-mismatch', record, expectedSeq, priorHash }; break; }
    records.push(record); priorHash = record.recordHash; expectedSeq++; offset = end + 1;
  }
  if (invalid && repair) withLock(dir, () => {
    const fresh = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    quarantine(dir, [{ reason: invalid.reason, byteOffset: invalid.offset, suffixHash: bytesHash(fresh.subarray(invalid.offset)), suffixBytes: fresh.subarray(invalid.offset).toString('utf8').slice(0, 8192) }]);
    const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, invalid.offset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  return { records, lastHash: priorHash, validBytes: offset, invalid };
}

function readJournal(dir, repair = true) { return parseJournal(dir, repair).records; }

function appendUnlocked(dir, record) {
  const state = parseJournal(dir, false);
  if (state.invalid) {
    const raw = fs.readFileSync(paths(dir).journal); quarantine(dir, [{ reason: state.invalid.reason, byteOffset: state.invalid.offset, suffixHash: bytesHash(raw.subarray(state.invalid.offset)), suffixBytes: raw.subarray(state.invalid.offset).toString('utf8').slice(0, 8192) }]);
    const fd = fs.openSync(paths(dir).journal, 'r+'); try { fs.ftruncateSync(fd, state.validBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const body = { ...record, seq: state.records.length + 1, epoch: record.epoch || 1, priorHash: state.lastHash, ts: new Date().toISOString() }; body.recordHash = hash(body);
  appendFileSync(paths(dir).journal, JSON.stringify(body) + '\n'); return body;
}
function append(dir, record) { return withLock(dir, () => appendUnlocked(dir, record)); }

function leaseParts(leaseOrOwner, token, epoch) {
  if (leaseOrOwner && leaseOrOwner.owner) return { owner: `fleethost:${leaseOrOwner.owner.pid}`, token: token || leaseOrOwner.token || leaseOrOwner.owner.token, epoch: epoch || leaseOrOwner.owner.epoch };
  return { owner: String(leaseOrOwner), token, epoch };
}
function assertLease(root, leaseOrOwner, token, epoch) {
  const p = path.join(root, 'sidecar-lease.json'); const l = leaseParts(leaseOrOwner, token, epoch); let current;
  try { current = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error('lease missing'); }
  if (current.token !== l.token || Number(current.epoch) !== Number(l.epoch)) throw new Error('stale lease fence rejected');
  return l;
}

function appendIngress(dir, text, source = 'journal', options = {}) {
  const content = String(text == null ? '' : text); if (!content) throw new Error('empty directive');
  return withLock(dir, () => {
    const prior = parseJournal(dir, false).records; const key = options.idempotencyKey == null ? null : String(options.idempotencyKey);
    if (key) { const existing = prior.find(r => r.kind === 'ingress' && r.idempotencyKey === key); if (existing) return existing; }
    const eventId = options.eventId || (key ? `event:${bytesHash(key)}` : `event:${crypto.randomUUID()}`);
    return appendUnlocked(dir, { kind: 'ingress', eventId, directiveId: eventId, idempotencyKey: key, contentHash: bytesHash(content), source, text: content, createdAt: new Date().toISOString() });
  });
}

function claimFiles(inbox) { return fs.existsSync(path.dirname(inbox)) ? fs.readdirSync(path.dirname(inbox)).filter(name => name.startsWith(path.basename(inbox) + '.claim.')).map(name => path.join(path.dirname(inbox), name)) : []; }
function reconcileLegacy(dir, inbox, source = 'legacy-say-inbox') {
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

function entries(dir) { const records = readJournal(dir); const byId = new Map(); for (const record of records) { if (!record.eventId && !record.directiveId) continue; const id = record.eventId || record.directiveId; const item = byId.get(id) || { ingress: null, claims: [], terminal: null }; if (record.kind === 'ingress') item.ingress = record; else if (record.kind === 'claim') item.claims.push(record); else if (record.kind === 'ack' || record.kind === 'fail') item.terminal = record; byId.set(id, item); } return { records, byId }; }
function getIngress(dir, eventId) { return entries(dir).byId.get(eventId)?.ingress || null; }
function terminal(dir, eventId) { return entries(dir).byId.get(eventId)?.terminal || null; }

function claimNext(dir, leaseOrOwner, epoch, token, claimTtlMs = 30000, maxReplays = 3) {
  return withLock(dir, () => {
    const l = leaseParts(leaseOrOwner, token, epoch); assertLease(dir, leaseOrOwner, token, epoch); const snapshot = entries(dir); const now = Date.now();
    const candidate = [...snapshot.byId.values()].find(item => item.ingress && !item.terminal && !item.claims.some(c => Number(c.expiresAt || 0) > now)); if (!candidate) return null;
    const priorClaim = candidate.claims[candidate.claims.length - 1];
    if (candidate.claims.length >= maxReplays) { appendUnlocked(dir, { kind: 'fail', eventId: candidate.ingress.eventId || candidate.ingress.directiveId, directiveId: candidate.ingress.directiveId, reason: `replay-limit-${maxReplays}`, owner: l.owner, token: l.token, epoch: l.epoch, replayCount: candidate.claims.length }); return null; }
    return appendUnlocked(dir, { kind: 'claim', eventId: candidate.ingress.eventId || candidate.ingress.directiveId, directiveId: candidate.ingress.directiveId, contentHash: candidate.ingress.contentHash, owner: l.owner, token: l.token, epoch: l.epoch, expiresAt: now + claimTtlMs, replay: Boolean(priorClaim), claimCount: candidate.claims.length + 1 });
  });
}

function terminalAppend(dir, kind, eventId, result, leaseOrOwner, epoch, token, extra = {}) { return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const existing = terminal(dir, eventId); if (existing) return existing; return appendUnlocked(dir, { kind, eventId, directiveId: eventId, resultHash: bytesHash(result), result: String(result), owner: l.owner, token: l.token, epoch: l.epoch, ...extra }); }); }
function ack(dir, eventId, result, leaseOrOwner, epoch, token, extra) { return terminalAppend(dir, 'ack', eventId, result, leaseOrOwner, epoch, token, extra); }
function fail(dir, eventId, reason, leaseOrOwner, epoch, token) { return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const existing = terminal(dir, eventId); if (existing) return existing; return appendUnlocked(dir, { kind: 'fail', eventId, directiveId: eventId, reason: String(reason), owner: l.owner, token: l.token, epoch: l.epoch }); }); }

function appendOutbox(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const rows = readJsonLines(file); if (entry.directiveId) { const same = rows.find(row => row.directiveId === entry.directiveId); if (same) { if (entry.reply == null || same.reply === entry.reply) return same; throw new Error('outbox result conflict for event'); } }
  const body = { ...entry, resultHash: entry.resultHash || bytesHash(entry.reply || entry.error || JSON.stringify(entry)), ts: new Date().toISOString() }; body.recordHash = hash(body); appendFileSync(file, JSON.stringify(body) + '\n'); return body;
}
function repairPublication(dir, outboxFile, leaseOrOwner, epoch, token) {
  const rows = readJsonLines(outboxFile); const repaired = [];
  for (const row of rows) { if (!row.directiveId || terminal(dir, row.directiveId)) continue; repaired.push(ack(dir, row.directiveId, JSON.stringify(row), leaseOrOwner, epoch, token, { repairedFromOutbox: true, outboxRecordHash: row.recordHash })); }
  for (const record of readJournal(dir)) { if (record.kind !== 'ack' || !record.result || rows.some(row => row.directiveId === record.directiveId)) continue; appendOutbox(outboxFile, { directiveId: record.directiveId, reply: record.result, resultHash: record.resultHash, repairedFromAck: true }); }
  return repaired;
}
function telemetry(dir) {
  const snapshot = entries(dir); const now = Date.now(); const pending = [...snapshot.byId.values()].filter(item => item.ingress && !item.terminal);
  const claims = pending.flatMap(item => item.claims); const active = claims.filter(claim => Number(claim.expiresAt || 0) > now);
  return { journalDepth: snapshot.records.length, queueDepth: pending.length, oldestAgeMs: pending.length ? Math.max(0, now - Date.parse(pending[0].ingress.createdAt || now)) : 0, activeClaimExpiry: active.length ? Math.min(...active.map(claim => claim.expiresAt)) : null, replayCount: claims.filter(claim => claim.replay).length, quarantineBytes: fs.existsSync(paths(dir).quarantine) ? fs.statSync(paths(dir).quarantine).size : 0 };
}
function appendError(dir, error, context = {}) { return append(dir, { kind: 'sidecar-error', error: String(error?.stack || error), context }); }

module.exports = { hash, bytesHash, paths, withLock, readJournal, append, appendIngress, reconcileLegacy, claimNext, getIngress, terminal, ack, fail, appendOutbox, repairPublication, telemetry, appendError, claimFiles, assertLease };
