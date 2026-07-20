'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function file(root) { return path.join(root, 'sidecar-lease.json'); }
function historyFile(root) { return path.join(root, 'sidecar-lease-history.ndjson'); }
function lockFile(root) { return path.join(root, 'sidecar-lease.lock'); }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function fsyncDir(root) { try { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch {} }
function atomicWrite(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, JSON.stringify(value), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath); fsyncDir(path.dirname(filePath));
}
function appendHistory(root, event) {
  const rows = readHistory(root); const body = { ...event, seq: rows.length + 1, priorHash: rows.at(-1)?.recordHash || null, ts: new Date().toISOString() }; body.recordHash = hash(body);
  const fd = fs.openSync(historyFile(root), 'a'); try { fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDir(root); return body;
}
function readHistory(root) {
  if (!fs.existsSync(historyFile(root))) return [];
  const rows = fs.readFileSync(historyFile(root), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); let prior = null;
  for (let i = 0; i < rows.length; i++) { const row = rows[i]; const copy = { ...row }; delete copy.recordHash; if (row.seq !== i + 1 || row.priorHash !== prior || row.recordHash !== hash(copy)) throw new Error('lease history chain invalid'); prior = row.recordHash; }
  return rows;
}
function writeLease(filePath, owner, root) { atomicWrite(filePath, owner); fsyncDir(root); }
function withLock(root, fn) {
  fs.mkdirSync(root, { recursive: true }); let fd = null; const identity = { pid: process.pid, startedAt: new Date().toISOString(), token: crypto.randomBytes(8).toString('hex') };
  for (let i = 0; i < 4000; i++) { try { fd = fs.openSync(lockFile(root), 'wx'); fs.writeSync(fd, JSON.stringify(identity), null, 'utf8'); fs.fsyncSync(fd); break; } catch (error) { if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error; try { const stale = JSON.parse(fs.readFileSync(lockFile(root), 'utf8')); const old = Date.now() - fs.statSync(lockFile(root)).mtimeMs > 60000; if (old || !alive(stale.pid)) fs.unlinkSync(lockFile(root)); } catch {} sleep(5); } }
  if (fd == null) throw new Error('lease lock timeout'); try { return fn(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockFile(root)); } catch {} }
}
function read(root) { try { return JSON.parse(fs.readFileSync(file(root), 'utf8')); } catch { return null; } }
function activeHistory(root, token, epoch) {
  const rows = readHistory(root); const acquire = rows.find(r => r.kind === 'acquire' && r.token === token && Number(r.epoch) === Number(epoch));
  if (!acquire) throw new Error('unknown lease token');
  const end = rows.find(r => Number(r.epoch) === Number(epoch) && r.kind === 'release' && r.token === token || Number(r.epoch) === Number(epoch) && r.kind === 'fence' && r.token === token);
  if (end) throw new Error('lease token already released');
  return acquire;
}
function validate(root, token, epoch) {
  const current = read(root); if (!current || current.status === 'released' || current.token !== token || Number(current.epoch) !== Number(epoch)) throw new Error('stale lease fence rejected');
  activeHistory(root, token, epoch); return current;
}

function acquire(root, ttlMs = 15000) {
  fs.mkdirSync(root, { recursive: true }); const startedAt = new Date().toISOString(); const token = crypto.randomBytes(32).toString('hex');
  const lease = withLock(root, () => {
    const prior = read(root); const rows = readHistory(root); const maxEpoch = Math.max(Number(prior?.epoch || 0), ...rows.map(r => Number(r.epoch || 0)), 0);
    if (prior && prior.status !== 'released' && Date.now() - Number(prior.heartbeatAt || 0) < Number(prior.ttlMs || ttlMs) && alive(prior.pid)) throw new Error(`sidecar lease held by pid ${prior.pid} epoch ${prior.epoch}`);
    if (prior && prior.status !== 'released') appendHistory(root, { kind: 'fence', epoch: prior.epoch, pid: prior.pid, startIdentity: prior.startIdentity, token: prior.token, reason: alive(prior.pid) ? 'stale-heartbeat' : 'owner-dead' });
    const owner = { status: 'active', pid: process.pid, startedAt, startIdentity: `${process.pid}:${startedAt}:${token.slice(0, 16)}`, supervisorNonce: token, token, epoch: maxEpoch + 1, heartbeatAt: Date.now(), ttlMs };
    appendHistory(root, { kind: 'acquire', epoch: owner.epoch, pid: owner.pid, startIdentity: owner.startIdentity, token }); writeLease(file(root), owner, root); return owner;
  });
  let active = true;
  function heartbeat() { if (!active) return; withLock(root, () => { const current = validate(root, lease.token, lease.epoch); current.heartbeatAt = Date.now(); writeLease(file(root), current, root); }); }
  function release(reason = 'graceful') { if (!active) return; active = false; try { withLock(root, () => { const current = validate(root, lease.token, lease.epoch); appendHistory(root, { kind: 'release', epoch: lease.epoch, pid: process.pid, startIdentity: lease.startIdentity, token: lease.token, reason }); current.status = 'released'; current.releasedAt = Date.now(); writeLease(file(root), current, root); }); } catch {} }
  const timer = setInterval(() => { try { heartbeat(); } catch (error) { active = false; try { appendHistory(root, { kind: 'fence', epoch: lease.epoch, pid: process.pid, startIdentity: lease.startIdentity, token: lease.token, reason: String(error) }); } catch {} } }, Math.max(1000, Math.floor(ttlMs / 3))); timer.unref?.();
  return { owner: lease, token: lease.token, epoch: lease.epoch, fencingToken: hash(lease), heartbeat, release };
}

module.exports = { acquire, file, historyFile, alive, read, readHistory, validate, withLock, hash };
