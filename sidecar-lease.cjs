'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function file(root) { return path.join(root, 'sidecar-lease.json'); }
function lockFile(root) { return path.join(root, 'sidecar-lease.lock'); }
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function writeLease(filePath, owner) { const fd = fs.openSync(filePath, 'w'); try { fs.writeSync(fd, JSON.stringify(owner), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function withLock(root, fn) {
  let fd = null; for (let i = 0; i < 4000; i++) { try { fd = fs.openSync(lockFile(root), 'wx'); break; } catch (error) { if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error; try { if (Date.now() - fs.statSync(lockFile(root)).mtimeMs > 60000) fs.unlinkSync(lockFile(root)); } catch {} sleep(5); } }
  if (fd == null) throw new Error('lease lock timeout'); try { fs.fsyncSync(fd); return fn(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockFile(root)); } catch {} }
}
function read(root) { try { return JSON.parse(fs.readFileSync(file(root), 'utf8')); } catch { return null; } }
function validate(root, token, epoch) { const current = read(root); if (!current || current.token !== token || Number(current.epoch) !== Number(epoch)) throw new Error('stale lease fence rejected'); return current; }

function acquire(root, ttlMs = 15000) {
  fs.mkdirSync(root, { recursive: true }); const startedAt = new Date().toISOString(); const token = crypto.randomBytes(32).toString('hex');
  const owner = { pid: process.pid, startedAt, startIdentity: `${process.pid}:${startedAt}:${token.slice(0, 16)}`, supervisorNonce: token, token, epoch: 1, heartbeatAt: Date.now(), ttlMs };
  const lease = withLock(root, () => {
    const prior = read(root); if (prior && alive(prior.pid) && Date.now() - Number(prior.heartbeatAt || 0) < Number(prior.ttlMs || ttlMs)) throw new Error(`sidecar lease held by pid ${prior.pid} epoch ${prior.epoch}`);
    owner.epoch = Number(prior?.epoch || 0) + 1; writeLease(file(root), owner); return owner;
  });
  let active = true;
  function heartbeat() {
    if (!active) return;
    withLock(root, () => {
      const current = validate(root, owner.token, owner.epoch); owner.heartbeatAt = Date.now(); owner.epoch = current.epoch; writeLease(file(root), owner);
    });
  }
  function release() { if (!active) return; active = false; try { withLock(root, () => { const current = read(root); if (current?.token === owner.token && Number(current.epoch) === Number(owner.epoch)) fs.unlinkSync(file(root)); }); } catch {} }
  const timer = setInterval(() => { try { heartbeat(); } catch (error) { active = false; try { fs.writeFileSync(path.join(root, 'sidecar-lease-fence-error.ndjson'), JSON.stringify({ ts: new Date().toISOString(), error: String(error) }) + '\n', { flag: 'a' }); } catch {} } }, Math.max(1000, Math.floor(ttlMs / 3))); timer.unref?.();
  return { owner: lease, token: owner.token, epoch: owner.epoch, fencingToken: hash(owner), heartbeat, release };
}

module.exports = { acquire, file, alive, read, validate, withLock };
