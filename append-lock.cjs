'use strict';

const fs = require('fs');
const crypto = require('crypto');

const pause = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function reapStale(lockPath) {
  let observed;
  let stat;
  try {
    observed = fs.readFileSync(lockPath, 'utf8');
    stat = fs.statSync(lockPath);
  } catch (error) {
    return error.code === 'ENOENT';
  }
  let owner = null;
  try { owner = JSON.parse(observed); } catch {}
  if (owner && processAlive(owner.pid)) return false;
  if (!owner && Date.now() - stat.mtimeMs < 5000) return false;
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== observed) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function acquire(lockPath, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const token = crypto.randomBytes(16).toString('hex');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() }));
      fs.fsyncSync(fd);
      return { fd, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reapStale(lockPath)) continue;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  throw new Error(`append lock busy: ${lockPath}`);
}

function release(lockPath, lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.token === lock.token) fs.unlinkSync(lockPath);
  } catch {}
}

module.exports = { acquire, release, processAlive, reapStale };
