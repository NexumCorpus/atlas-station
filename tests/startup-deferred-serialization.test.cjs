'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deferred = require('../deferred.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-deferred-'));
try {
  const first = deferred.deferTask('Preserve the first queued task', {
    blocker: 'The startup task has not entered the serialized ingress queue',
    nextAction: 'Queue the task with a durable ingress receipt',
    validationCondition: 'The task reaches a terminal state through the ingress journal',
  }, tmp);
  const second = deferred.deferTask('Keep the second task pending', {
    blocker: 'The bounded startup queue is already at its dispatch limit',
    nextAction: 'Leave this task pending for a later bounded queue pass',
    validationCondition: 'The task remains pending until explicitly queued',
  }, tmp);

  const receipt = { eventId: 'event:test-deferred', recordHash: 'sha256:ingress' };
  const queued = deferred.markQueued(first.id, receipt, tmp);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.ingressEventId, receipt.eventId);
  assert.equal(deferred.markQueued(first.id, receipt, tmp).state, 'queued', 'queue receipt is idempotent');
  assert.deepEqual(deferred.peekPending(tmp).map(task => task.id), [second.id], 'unselected task stays pending');

  const terminal = { kind: 'ack', recordHash: 'sha256:terminal' };
  const consumed = deferred.markTerminal(first.id, terminal, tmp);
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.terminalRecordHash, terminal.recordHash);
  assert.equal(deferred.markTerminal(first.id, terminal, tmp).state, 'consumed', 'terminal receipt is idempotent');
  assert.throws(
    () => deferred.markTerminal(first.id, { kind: 'ack', recordHash: 'sha256:other' }, tmp),
    /terminal receipt conflict/
  );

  const source = fs.readFileSync(path.join(__dirname, '..', 'fleethost.mjs'), 'utf8');
  const start = source.indexOf('function runDeferredTasks()');
  const end = source.indexOf('// Station nerve', start);
  const startupPath = source.slice(start, end);
  assert(start >= 0 && end > start, 'startup queue implementation is present');
  assert(startupPath.includes("appendIngress(INGRESS_DIR, prompt, 'startup-deferred'"), 'startup tasks enter ingress');
  assert(startupPath.includes('_deferred.markQueued'), 'startup queue persists its receipt');
  assert(!startupPath.includes('runSubagent('), 'startup queue never launches a second model worker');
  assert(!startupPath.includes('popPending('), 'startup queue never claims more work than it durably queues');

  console.log('startup deferred serialization: PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
