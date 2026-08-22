'use strict';

const fs = require('fs');
const crypto = require('crypto');

const pause = new Int32Array(new SharedArrayBuffer(4));

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

module.exports = { acquire, release };
