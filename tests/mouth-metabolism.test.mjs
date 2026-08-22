import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createOrchestrationLanes } from '../orchestration-lanes.mjs';

const require = createRequire(import.meta.url);
const ingress = require('../ingress-journal.cjs');
const leases = require('../sidecar-lease.cjs');

let passed = 0;
async function check(label, fn) {
  try { await fn(); console.log('  PASS:', label); passed++; }
  catch (error) { console.error('  FAIL:', label, '-', error.stack || error); process.exitCode = 1; }
}

console.log('\n=== mouth / metabolism contract ===\n');

await check('a blocked metabolism turn cannot head-of-line block the mouth', async () => {
  const lanes = createOrchestrationLanes();
  let releaseMetabolism;
  const gate = new Promise(resolve => { releaseMetabolism = resolve; });
  const order = [];
  const metabolism = lanes.enqueue('metabolism', async () => { order.push('metabolism:start'); await gate; order.push('metabolism:end'); });
  await Promise.resolve();
  const mouth = lanes.enqueue('mouth', async () => { order.push('mouth'); return 'alive'; });
  assert.equal(await mouth, 'alive');
  assert.deepEqual(order, ['metabolism:start', 'mouth']);
  releaseMetabolism();
  await metabolism;
  assert.deepEqual(order, ['metabolism:start', 'mouth', 'metabolism:end']);
});

await check('each lane is FIFO and a failed metabolism turn does not poison either lane', async () => {
  const lanes = createOrchestrationLanes();
  const order = [];
  const first = lanes.enqueue('mouth', async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('mouth:1'); });
  const second = lanes.enqueue('mouth', async () => { order.push('mouth:2'); });
  await assert.rejects(lanes.enqueue('metabolism', async () => { throw new Error('bounded failure'); }), /bounded failure/);
  await lanes.enqueue('metabolism', async () => { order.push('metabolism:recovered'); });
  await Promise.all([first, second]);
  await lanes.drain();
  assert.ok(order.indexOf('mouth:1') < order.indexOf('mouth:2'));
  assert.ok(order.includes('metabolism:recovered'));
});

await check('operator ingress preempts older background work and receipts carry lane provenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lanes-'));
  const lease = leases.acquire(root, 15000);
  try {
    const background = ingress.appendIngress(root, 'restore deferred work', 'startup-deferred');
    const operator = ingress.appendIngress(root, 'Daniel speaks now', 'ipc-say');
    const mouth = ingress.claimNext(root, lease, lease.epoch, lease.token, 30000, 3, {});
    assert.equal(mouth.eventId, operator.eventId);
    assert.equal(mouth.lane, 'mouth');
    const metabolism = ingress.claimNext(root, lease, lease.epoch, lease.token, 30000, 3, { allowOperator: false });
    assert.equal(metabolism.eventId, background.eventId);
    assert.equal(metabolism.lane, 'metabolism');
    const renewal = ingress.renewClaim(root, mouth.eventId, { ...mouth, claimRecordHash: mouth.recordHash }, lease, lease.epoch, lease.token, 30000);
    assert.equal(renewal.lane, 'mouth');
  } finally {
    lease.release('test-complete');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed\n`);
