'use strict';

// Explicit PTY bridge verifier. Importing this module is inert so the release
// smoke suite cannot start a model or IPC child as a side effect.
const { spawn } = require('child_process');
const path = require('path');

function verifyPtyBridge(options = {}) {
  const timeoutMs = options.timeoutMs || 4500;
  const host = spawn(process.execPath, [path.join(__dirname, 'ptyhost.cjs')], {
    cwd: __dirname,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  return new Promise((resolve) => {
    let bytes = 0;
    let sample = '';
    let fatal = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { host.kill(); } catch {}
      resolve(result);
    };

    host.on('message', (message) => {
      if (message && message.t === 'd') {
        bytes += message.d.length;
        if (sample.length < 600) sample += message.d;
      } else if (message && message.t === 'fatal') {
        fatal = message.m;
      }
    });
    host.once('error', error => finish({ ok: false, bytes, sample, error: error.message }));
    host.once('close', (code, signal) => {
      if (!settled && (fatal || bytes === 0)) finish({ ok: false, bytes, sample, fatal, code, signal });
    });
    if (host.stderr) host.stderr.on('data', buffer => {
      if (options.forwardStderr) process.stderr.write(`[host stderr] ${buffer}`);
    });

    setTimeout(() => {
      if (host.connected) {
        try { host.send({ t: 'r', cols: 120, rows: 30 }); } catch {}
      }
    }, 300);
    setTimeout(() => finish({ ok: bytes > 0 && !fatal, bytes, sample, fatal }), timeoutMs);
  });
}

async function main() {
  const result = await verifyPtyBridge();
  const clean = result.sample
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[^\x20-\x7e\n]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 180);
  console.log('PTY bytes received:', result.bytes);
  console.log('sample (cleaned):', JSON.stringify(clean));
  console.log(`\nSIDECAR: ${result.ok ? 'PASS — configured provider output crossed the PTY bridge.' : `NO DATA — ${result.fatal || result.error || 'configured provider emitted no output'}`}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { verifyPtyBridge };
