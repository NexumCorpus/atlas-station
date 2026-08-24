'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ingress = require('../ingress-journal.cjs');
const leases = require('../sidecar-lease.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-repair-'));
const outbox = path.join(root, 'say-outbox.jsonl');
const lease = leases.acquire(root, 15_000);
try {
  const orphanPublication = ingress.appendIngress(root, 'repair terminal', 'ipc-say');
  const claimA = ingress.claimNext(root, lease, lease.epoch, lease.token, 30_000, 3, { providerModel: 'test-model', providerSessionId: 'test-session' });
  assert.equal(claimA.eventId, orphanPublication.eventId);
  ingress.appendOutbox(outbox, { directiveId: orphanPublication.eventId, reply: 'recovered reply' });
  const repaired = ingress.repairPublication(root, outbox, lease, lease.epoch, lease.token);
  assert.equal(repaired.length, 1);
  assert.equal(ingress.terminal(root, orphanPublication.eventId).publication.reply, 'recovered reply');

  const orphanFailure = ingress.appendIngress(root, 'repair failed terminal', 'ipc-say');
  const claimFailure = ingress.claimNext(root, lease, lease.epoch, lease.token, 30_000, 3, { providerModel: 'test-model', providerSessionId: 'test-session' });
  assert.equal(claimFailure.eventId, orphanFailure.eventId);
  ingress.appendOutbox(outbox, { directiveId: orphanFailure.eventId, error: 'provider failed before terminal append' });
  ingress.repairPublication(root, outbox, lease, lease.epoch, lease.token);
  const repairedFailure = ingress.terminal(root, orphanFailure.eventId);
  assert.equal(repairedFailure.kind, 'fail', 'an error publication must never be repaired as success');
  assert.equal(repairedFailure.publication.error, 'provider failed before terminal append');

  const orphanAck = ingress.appendIngress(root, 'repair publication', 'ipc-say');
  const claimB = ingress.claimNext(root, lease, lease.epoch, lease.token, 30_000, 3, { providerModel: 'test-model', providerSessionId: 'test-session', workerStartIdentity: 'test-worker' });
  assert.equal(claimB.eventId, orphanAck.eventId);
  const attempt = {
    attemptId: claimB.attemptId,
    claimRecordHash: claimB.recordHash,
    contentHash: claimB.contentHash,
    tokenFingerprint: claimB.tokenFingerprint,
    workerPid: claimB.workerPid,
    workerStartIdentity: claimB.workerStartIdentity,
    providerSessionId: claimB.providerSessionId,
    providerModel: claimB.providerModel,
    executionPath: 'model',
  };
  ingress.ack(root, orphanAck.eventId, JSON.stringify({ reply: 'published reply' }), lease, lease.epoch, lease.token, attempt);
  ingress.repairPublication(root, outbox, lease, lease.epoch, lease.token);
  const rows = fs.readFileSync(outbox, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.filter(row => row.directiveId === orphanAck.eventId).length, 1);
  assert.equal(rows.find(row => row.directiveId === orphanAck.eventId).reply, 'published reply');

  // An adjudication changes journal authority without rewriting history. Repair
  // must append an explicit outbox supersession and deterministic readers must
  // expose only the replacement publication.
  const adjudicated = ingress.appendIngress(root, 'adjudicated publication', 'ipc-say');
  const claimC = ingress.claimNext(root, lease, lease.epoch, lease.token, 30_000, 3, {
    providerModel: 'test-model', providerSessionId: 'test-session', workerStartIdentity: 'test-worker',
  });
  assert.equal(claimC.eventId, adjudicated.eventId);
  const attemptC = {
    attemptId: claimC.attemptId,
    claimRecordHash: claimC.recordHash,
    contentHash: claimC.contentHash,
    tokenFingerprint: claimC.tokenFingerprint,
    workerPid: claimC.workerPid,
    workerStartIdentity: claimC.workerStartIdentity,
    providerSessionId: claimC.providerSessionId,
    providerModel: claimC.providerModel,
    executionPath: 'model',
  };
  const rejectedPublication = ingress.appendOutbox(outbox, { directiveId: adjudicated.eventId, error: 'rejected failure' });
  const rejectedTerminal = ingress.fail(root, adjudicated.eventId, 'rejected failure', lease, lease.epoch, lease.token, attemptC);
  ingress.ack(root, adjudicated.eventId, JSON.stringify({ reply: 'adjudicated reply' }), lease, lease.epoch, lease.token, attemptC);
  const lateResult = ingress.entries(root).byId.get(adjudicated.eventId).lateResults.find(record => record.kind === 'late-result');
  assert.ok(lateResult, 'late ACK must exist as an adjudication candidate');
  ingress.adjudicateTerminal(root, adjudicated.eventId, rejectedTerminal.recordHash, lateResult.recordHash, {
    firstTerminalInvalid: true,
    eventId: adjudicated.eventId,
    replacementAttemptId: claimC.attemptId,
  }, lease, lease.epoch, lease.token);
  assert.equal(ingress.authoritativeTerminal(root, adjudicated.eventId).recordHash, lateResult.recordHash);

  ingress.repairPublication(root, outbox, lease, lease.epoch, lease.token);
  const adjudicatedHistory = fs.readFileSync(outbox, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .filter(row => row.directiveId === adjudicated.eventId);
  assert.equal(adjudicatedHistory.length, 2, 'repair must preserve the rejected row and append one supersession');
  assert.equal(adjudicatedHistory[1].supersedesOutboxRecordHash, rejectedPublication.recordHash);
  assert.equal(adjudicatedHistory[1].authoritativeTerminalRecordHash, lateResult.recordHash);
  assert.equal(adjudicatedHistory[1].supersessionReason, 'authoritative-terminal-changed');
  const effective = ingress.readOutbox(outbox).find(row => row.directiveId === adjudicated.eventId);
  assert.equal(effective.reply, 'adjudicated reply');
  assert.equal(effective.error, null);
  const historyCount = adjudicatedHistory.length;
  ingress.repairPublication(root, outbox, lease, lease.epoch, lease.token);
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.directiveId === adjudicated.eventId).length, historyCount, 'supersession repair must be idempotent');

  // appendOutbox is the fail-closed publication primitive: conflicts and I/O
  // failures are typed exceptions, never falsey success values or extra rows.
  const beforeConflict = fs.readFileSync(outbox, 'utf8');
  assert.throws(
    () => ingress.appendOutbox(outbox, { directiveId: adjudicated.eventId, error: 'stale retry' }),
    error => error?.name === 'OutboxPublicationError' && error?.code === 'OUTBOX_RESULT_CONFLICT',
  );
  assert.equal(fs.readFileSync(outbox, 'utf8'), beforeConflict, 'failed publication must not mutate the append-only ledger');
  const invalidOutbox = path.join(root, 'not-an-outbox-file');
  fs.mkdirSync(invalidOutbox);
  assert.throws(
    () => ingress.appendOutbox(invalidOutbox, { directiveId: 'io-failure', reply: 'must not publish' }),
    error => error?.name === 'OutboxPublicationError' && error?.code === 'OUTBOX_PUBLICATION_FAILED',
  );
  console.log('ingress publication repair: ALL PASS');
} finally {
  lease.release('test-complete');
  fs.rmSync(root, { recursive: true, force: true });
}
