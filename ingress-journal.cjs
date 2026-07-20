'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function bytesHash(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function paths(dir) { return { journal: path.join(dir, 'ingress.ndjson'), quarantine: path.join(dir, 'ingress-quarantine.ndjson'), lock: path.join(dir, 'ingress.lock') }; }

function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = paths(dir).lock;
  let fd;
  for (let i = 0; i < 4000; i++) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (error) { if (error.code !== 'EEXIST') throw error; sleep(5); }
  }
  if (fd == null) throw new Error('ingress writer lock timeout');
  try { fs.writeSync(fd, `${process.pid}\n`, null, 'utf8'); fs.fsyncSync(fd); return fn(); }
  finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
}

function readJournal(dir, repair = true) {
  const p = paths(dir); if (!fs.existsSync(p.journal)) return [];
  const raw = fs.readFileSync(p.journal);
  const lines = raw.toString('utf8').split(/\n/);
  const records = []; let validBytes = 0; const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line && i === lines.length - 1) break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    try { records.push(JSON.parse(line)); validBytes += lineBytes; }
    catch { bad.push({ line: line.slice(0, 4096), reason: i === lines.length - 1 ? 'torn-tail' : 'invalid-line' }); }
  }
  if (bad.length && repair) withLock(dir, () => {
    const q = bad.map(item => JSON.stringify({ kind: 'quarantined-tail', ts: new Date().toISOString(), ...item })).join('\n') + '\n';
    const qfd = fs.openSync(p.quarantine, 'a'); try { fs.writeSync(qfd, q, null, 'utf8'); fs.fsyncSync(qfd); } finally { fs.closeSync(qfd); }
    const fd = fs.openSync(p.journal, 'r+'); try { fs.ftruncateSync(fd, Math.max(0, validBytes)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  return records;
}

function append(dir, record) {
  return withLock(dir, () => {
    const prior = readJournal(dir, false);
    const seq = prior.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
    const body = { ...record, seq, epoch: record.epoch || 1, ts: new Date().toISOString() };
    body.recordHash = hash(body);
    const fd = fs.openSync(paths(dir).journal, 'a'); try { fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return body;
  });
}

function state(dir) {
  const records = readJournal(dir); const byId = new Map();
  for (const record of records) {
    if (!record.directiveId) continue;
    const item = byId.get(record.directiveId) || { ingress: null, claims: [], terminal: null };
    if (record.kind === 'ingress') item.ingress = record;
    else if (record.kind === 'claim') item.claims.push(record);
    else if (record.kind === 'ack' || record.kind === 'fail') item.terminal = record;
    byId.set(record.directiveId, item);
  }
  return { records, byId };
}

function appendIngress(dir, text, source = 'journal') {
  const content = String(text == null ? '' : text); if (!content) throw new Error('empty directive');
  return append(dir, { kind: 'ingress', directiveId: bytesHash(`${source}\0${content}`), contentHash: bytesHash(content), source, text: content, createdAt: new Date().toISOString() });
}

function reconcileLegacy(dir, inbox, source = 'legacy-say-inbox') {
  if (!fs.existsSync(inbox)) return null;
  const claimPath = `${inbox}.claim.${process.pid}.${Date.now()}`;
  try { fs.renameSync(inbox, claimPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let text = ''; try { text = fs.readFileSync(claimPath, 'utf8'); } finally { try { fs.unlinkSync(claimPath); } catch {} }
  fs.closeSync(fs.openSync(inbox, 'a'));
  return text ? appendIngress(dir, text, source) : null;
}

function claimNext(dir, owner, epoch) {
  const snapshot = state(dir);
  const candidate = [...snapshot.byId.values()].find(item => item.ingress && !item.terminal);
  if (!candidate) return null;
  return append(dir, { kind: 'claim', directiveId: candidate.ingress.directiveId, contentHash: candidate.ingress.contentHash, owner, epoch, replay: candidate.claims.length > 0, claimCount: candidate.claims.length + 1 });
}

function getIngress(dir, directiveId) { return state(dir).byId.get(directiveId)?.ingress || null; }
function terminal(dir, directiveId) { return state(dir).byId.get(directiveId)?.terminal || null; }
function ack(dir, directiveId, result, owner, epoch) { return append(dir, { kind: 'ack', directiveId, resultHash: bytesHash(result), owner, epoch, result }); }
function fail(dir, directiveId, reason, owner, epoch) { return append(dir, { kind: 'fail', directiveId, reason: String(reason), owner, epoch }); }
function appendOutbox(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const body = { ...entry, ts: new Date().toISOString() }; body.recordHash = hash(body);
  const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return body;
}

module.exports = { hash, bytesHash, paths, withLock, readJournal, append, appendIngress, reconcileLegacy, claimNext, getIngress, terminal, ack, fail, appendOutbox };
