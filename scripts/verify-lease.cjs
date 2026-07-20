'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lease-'));
const modulePath = require.resolve('../sidecar-lease.cjs');
const childCode = `const l=require(${JSON.stringify(modulePath)}); try { const h=l.acquire(process.argv[1],2000); console.log(JSON.stringify({acquired:true,epoch:h.owner.epoch,pid:process.pid,fencingToken:h.fencingToken})); setTimeout(()=>{h.release();process.exit(0)},700); } catch(e) { console.log(JSON.stringify({acquired:false,reason:e.message})); process.exit(0); }`;

function run() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', childCode, dir], { encoding: 'utf8' });
    let stdout = '';
    p.stdout.on('data', chunk => { stdout += chunk; });
    p.once('error', reject);
    p.once('exit', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`child exit ${code}: ${stdout}`)));
  });
}

Promise.all([run(), run()]).then(async results => {
  assert.equal(results.filter(result => result.acquired).length, 1, 'exactly one sidecar may hold the lease');
  assert.equal(results.filter(result => !result.acquired).length, 1, 'the fenced sidecar must be rejected');
  const stalePath = path.join(dir, 'sidecar-lease.json');
  fs.writeFileSync(stalePath, JSON.stringify({ pid: 999999, epoch: 41, heartbeatAt: 0, ttlMs: 1 }));
  const lease = require('../sidecar-lease.cjs').acquire(dir, 2000);
  assert.equal(lease.owner.epoch, 42, 'stale takeover increments epoch');
  assert.equal(typeof lease.owner.token, 'string');
  assert(lease.owner.token.length >= 32, 'fencing token source is high entropy');
  lease.release();
  const old = require('../sidecar-lease.cjs').acquire(dir, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  const newer = require('../sidecar-lease.cjs').acquire(dir, 2000);
  assert.throws(() => old.heartbeat(), /stale lease fence/);
  const releasedEpoch = newer.owner.epoch;
  newer.release();
  const reacquired = require('../sidecar-lease.cjs').acquire(dir, 2000);
  assert(reacquired.owner.epoch > releasedEpoch, 'release is a tombstone and epochs never reset');
  assert(require('../sidecar-lease.cjs').readHistory(dir).some(row => row.kind === 'release' && row.epoch === releasedEpoch), 'release is durable in lease history');
  reacquired.release();
  console.log(JSON.stringify({ ok: true, dir, results, staleTakeoverEpoch: 42, monotonicReacquireEpoch: reacquired.owner.epoch, fencingTokenLengths: results.filter(r => r.acquired).map(r => r.fencingToken.length) }));
}).catch(error => { console.error(error); process.exitCode = 1; });
