'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function file(root) { return path.join(root, 'sidecar-lease.json'); }
function now() { return Date.now(); }
function processStart(pid) { try { return fs.statSync(`/proc/${pid}`).birthtimeMs || null; } catch { return null; } }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }

function acquire(root, ttlMs = 15000) {
  fs.mkdirSync(root, { recursive: true }); const leaseFile = file(root); const startedAt = new Date().toISOString(); const owner = { pid: process.pid, startedAt, startIdentity: `${process.pid}:${startedAt}`, processStart: processStart(process.pid), token: crypto.randomBytes(16).toString('hex'), epoch: 1, heartbeatAt: now(), ttlMs };
  if (fs.existsSync(leaseFile)) {
    let prior = null; try { prior = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch {}
    if (prior && alive(prior.pid) && now() - Number(prior.heartbeatAt || 0) < Number(prior.ttlMs || ttlMs)) throw new Error(`sidecar lease held by pid ${prior.pid} epoch ${prior.epoch}`);
    owner.epoch = Number(prior?.epoch || 0) + 1;
    try { fs.renameSync(leaseFile, `${leaseFile}.stale.${Date.now()}`); } catch (error) { throw new Error(`stale lease takeover race: ${error.message}`); }
  }
  const fd = fs.openSync(leaseFile, 'wx'); try { fs.writeSync(fd, JSON.stringify(owner), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let active = true;
  function heartbeat() { if (!active) return; owner.heartbeatAt = now(); const temp = `${leaseFile}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(owner)); const fd2 = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd2); } finally { fs.closeSync(fd2); } fs.renameSync(temp, leaseFile); }
  function release() { if (!active) return; active = false; try { const current = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); if (current.token === owner.token) fs.unlinkSync(leaseFile); } catch {} }
  const timer = setInterval(() => { try { heartbeat(); } catch {} }, Math.max(1000, Math.floor(ttlMs / 3))); timer.unref?.();
  return { owner, heartbeat, release, fencingToken: hash(owner) };
}

module.exports = { acquire, file, alive };
