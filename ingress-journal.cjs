'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function bytesHash(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function hash(value) { return bytesHash(JSON.stringify(value)); }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function canonicalDir(dir) {
  const resolved = path.resolve(dir || path.join(__dirname, '.atlas'));
  return resolved === path.resolve(__dirname) ? path.join(resolved, '.atlas') : resolved;
}
function paths(dir) { const root = canonicalDir(dir); return { journal: path.join(root, 'ingress.ndjson'), quarantine: path.join(root, 'ingress-quarantine.ndjson'), migration: path.join(root, 'ingress-migration-anchor.json'), lock: path.join(root, 'ingress.lock'), errors: path.join(root, 'sidecar-errors.ndjson') }; }
function readJsonLines(file) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map(line => JSON.parse(line)); }
function appendFileSync(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, body, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

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
  return withLock(dir, () => {
    const prior = parseJournal(dir, false).records; const key = options.idempotencyKey == null ? null : String(options.idempotencyKey);
    if (key) { const existing = prior.find(r => r.kind === 'ingress' && r.idempotencyKey === key); if (existing) { if (existing.source !== source || existing.contentHash !== bytesHash(content)) { quarantine(dir, [{ reason: 'idempotency-conflict', idempotencyKey: key, existingRecordHash: existing.recordHash, source, contentHash: bytesHash(content) }]); throw new Error('idempotency key content conflict'); } return existing; } }
    const eventId = options.eventId || (key ? `event:${bytesHash(key)}` : `event:${crypto.randomUUID()}`);
    const sameId = prior.find(r => r.kind === 'ingress' && (r.eventId === eventId || r.directiveId === eventId));
    if (sameId && (sameId.source !== source || sameId.contentHash !== bytesHash(content))) { quarantine(dir, [{ reason: 'event-id-conflict', eventId, existingRecordHash: sameId.recordHash, source, contentHash: bytesHash(content) }]); throw new Error('event id content conflict'); }
    if (sameId) return sameId;
    return appendUnlocked(dir, { kind: 'ingress', eventId, directiveId: eventId, idempotencyKey: key, contentHash: bytesHash(content), source, text: content, createdAt: new Date().toISOString() });
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

function entries(dir) { dir = canonicalDir(dir); const state = parseJournal(dir, false); const records = state.invalid?.record ? [...state.records, { ...state.invalid.record, __quarantined: true }] : state.records; const byId = new Map(); for (const record of records) { if (!record.eventId && !record.directiveId) continue; const id = record.eventId || record.directiveId; const item = byId.get(id) || { ingress: null, claims: [], terminal: null, terminalConflicts: [], lateResults: [] }; if (record.kind === 'ingress') item.ingress ||= record; else if (record.kind === 'claim') item.claims.push(record); else if (record.kind === 'ack' || record.kind === 'fail') { if (!item.terminal) item.terminal = record; else { item.terminalConflicts.push(record); if (record.kind === 'ack') item.lateResults.push(record); } } byId.set(id, item); } return { records: state.records, byId }; }
function getIngress(dir, eventId) { return entries(dir).byId.get(eventId)?.ingress || null; }
function terminal(dir, eventId) { return entries(dir).byId.get(eventId)?.terminal || null; }

function claimNext(dir, leaseOrOwner, epoch, token, claimTtlMs = 30000, maxReplays = 3) {
  dir = canonicalDir(dir);
  return withLock(dir, () => {
    const l = leaseParts(leaseOrOwner, token, epoch); assertLease(dir, leaseOrOwner, token, epoch); const snapshot = entries(dir); const now = Date.now();
    const candidate = [...snapshot.byId.values()].find(item => item.ingress && !item.terminal && !item.claims.some(c => Number(c.expiresAt || 0) > now)); if (!candidate) return null;
    const priorClaim = candidate.claims[candidate.claims.length - 1];
    if (candidate.claims.length >= maxReplays) { appendUnlocked(dir, { kind: 'fail', eventId: candidate.ingress.eventId || candidate.ingress.directiveId, directiveId: candidate.ingress.directiveId, reason: `replay-limit-${maxReplays}`, owner: l.owner, token: l.token, epoch: l.epoch, replayCount: candidate.claims.length }); return null; }
    return appendUnlocked(dir, { kind: 'claim', eventId: candidate.ingress.eventId || candidate.ingress.directiveId, directiveId: candidate.ingress.directiveId, contentHash: candidate.ingress.contentHash, owner: l.owner, token: l.token, epoch: l.epoch, expiresAt: now + claimTtlMs, replay: Boolean(priorClaim), claimCount: candidate.claims.length + 1 });
  });
}

function terminalAppend(dir, kind, eventId, result, leaseOrOwner, epoch, token, extra = {}) { return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const existing = terminal(dir, eventId); if (existing) { appendUnlocked(dir, { kind: 'terminal-conflict', eventId, directiveId: eventId, firstTerminalHash: existing.recordHash, attemptedKind: kind, owner: l.owner, token: l.token, epoch: l.epoch }); if (kind === 'ack') appendUnlocked(dir, { kind: 'late-result', eventId, directiveId: eventId, resultHash: bytesHash(result), result: String(result), firstTerminalHash: existing.recordHash, owner: l.owner, token: l.token, epoch: l.epoch }); return existing; } let canonical; try { canonical = JSON.parse(String(result)); } catch { canonical = { reply: String(result) }; } return appendUnlocked(dir, { kind, eventId, directiveId: eventId, resultHash: bytesHash(result), result: String(result), publication: { reply: canonical.reply ?? null, error: canonical.error ?? null, control: canonical.control ?? null }, owner: l.owner, token: l.token, epoch: l.epoch, ...extra }); }); }
function ack(dir, eventId, result, leaseOrOwner, epoch, token, extra) { return terminalAppend(dir, 'ack', eventId, result, leaseOrOwner, epoch, token, extra); }
function fail(dir, eventId, reason, leaseOrOwner, epoch, token) { return withLock(dir, () => { const l = assertLease(dir, leaseOrOwner, token, epoch); const existing = terminal(dir, eventId); if (existing) { appendUnlocked(dir, { kind: 'terminal-conflict', eventId, directiveId: eventId, firstTerminalHash: existing.recordHash, attemptedKind: 'fail', reason: String(reason), owner: l.owner, token: l.token, epoch: l.epoch }); return existing; } return appendUnlocked(dir, { kind: 'fail', eventId, directiveId: eventId, reason: String(reason), owner: l.owner, token: l.token, epoch: l.epoch }); }); }

function appendOutbox(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); let rows; try { rows = readJsonLines(file); } catch { const raw = fs.readFileSync(file); const boundary = raw.lastIndexOf(0x0a); appendFileSync(`${file}.quarantine`, JSON.stringify({ reason: 'outbox-corrupt-tail', suffixHash: bytesHash(raw.subarray(Math.max(0, boundary + 1))) }) + '\n'); const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, Math.max(0, boundary + 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } rows = readJsonLines(file); }
  if (entry.directiveId) { const same = rows.find(row => row.directiveId === entry.directiveId); if (same) { if ((entry.resultHash || bytesHash(entry.reply || entry.error || JSON.stringify(entry))) === same.resultHash) return same; throw new Error('outbox result conflict for event'); } }
  const body = { ...entry, resultHash: entry.resultHash || bytesHash(entry.reply || entry.error || JSON.stringify(entry)), ts: new Date().toISOString() }; body.recordHash = hash(body); appendFileSync(file, JSON.stringify(body) + '\n'); return body;
}
function repairPublication(dir, outboxFile, leaseOrOwner, epoch, token) {
  dir = canonicalDir(dir);
  let rows = []; try { rows = readJsonLines(outboxFile); } catch {}
  const repaired = [];
  for (const row of rows) { if (!row.directiveId || terminal(dir, row.directiveId)) continue; repaired.push(ack(dir, row.directiveId, JSON.stringify({ reply: row.reply ?? null, error: row.error ?? null, control: row.control ?? null }), leaseOrOwner, epoch, token, { repairedFromOutbox: true, outboxRecordHash: row.recordHash })); }
  for (const record of readJournal(dir)) { if (record.kind !== 'ack' || !record.result || rows.some(row => row.directiveId === record.directiveId)) continue; const publication = record.publication || (() => { try { const parsed = JSON.parse(record.result); return { reply: parsed.reply ?? null, error: parsed.error ?? null, control: parsed.control ?? null }; } catch { return { reply: record.result, error: null, control: null }; } })(); appendOutbox(outboxFile, { directiveId: record.directiveId, ...publication, resultHash: record.resultHash, repairedFromAck: true }); }
  return repaired;
}
function telemetry(dir) {
  dir = canonicalDir(dir);
  const snapshot = entries(dir); const now = Date.now(); const pending = [...snapshot.byId.values()].filter(item => item.ingress && !item.terminal);
  const claims = pending.flatMap(item => item.claims); const active = claims.filter(claim => Number(claim.expiresAt || 0) > now);
  return { journalDepth: snapshot.records.length, queueDepth: pending.length, oldestAgeMs: pending.length ? Math.max(0, now - Date.parse(pending[0].ingress.createdAt || now)) : 0, activeClaimExpiry: active.length ? Math.min(...active.map(claim => claim.expiresAt)) : null, replayCount: claims.filter(claim => claim.replay).length, quarantineBytes: fs.existsSync(paths(dir).quarantine) ? fs.statSync(paths(dir).quarantine).size : 0 };
}
function appendError(dir, error, context = {}) { return append(canonicalDir(dir), { kind: 'sidecar-error', error: String(error?.stack || error), context }); }

module.exports = { hash, bytesHash, canonicalDir, paths, withLock, readJournal, append, appendIngress, reconcileLegacy, claimNext, getIngress, entries, terminal, ack, fail, appendOutbox, repairPublication, telemetry, appendError, claimFiles, assertLease, salvageIngress };
