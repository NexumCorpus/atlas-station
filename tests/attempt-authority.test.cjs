'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../ingress-journal.cjs');
const leaseApi = require('../sidecar-lease.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-attempt-authority-'));
const lease = leaseApi.acquire(root, 2000);
const epoch = lease.owner.epoch;
const token = lease.token;
const meta = { workerPid: 501, workerStartIdentity: '501:boot-a', providerSessionId: 'codex:test-session', providerModel: 'gpt-5.6-luna' };

const first = journal.appendIngress(root, 'long provider directive', 'test', { idempotencyKey: 'attempt-one' });
const second = journal.appendIngress(root, 'independent queued directive', 'test', { idempotencyKey: 'attempt-two' });
const claim = journal.claimNext(root, lease, epoch, token, 35, 3, meta);
assert.equal(claim.eventId, first.eventId);
assert.match(claim.attemptId, /^attempt:/);
const secondClaim = journal.claimNext(root, lease, epoch, token, 35, 3, { ...meta, workerPid: 502, workerStartIdentity: '502:boot-b' });
assert.equal(secondClaim.eventId, second.eventId, 'second event may claim independently');
const renewal = journal.renewClaim(root, first.eventId, { ...meta, attemptId: claim.attemptId, claimRecordHash: claim.recordHash, contentHash: claim.contentHash }, lease, epoch, token, 1000);
assert.equal(renewal.kind, 'claim-renewal');
assert.equal(journal.claimNext(root, lease, epoch, token, 35, 3, meta), null, 'renewal must suppress replay while both attempts live');

const wrong = { ...meta, attemptId: claim.attemptId, claimRecordHash: claim.recordHash, contentHash: 'sha256:wrong', executionPath: 'model' };
assert.throws(() => journal.ack(root, first.eventId, JSON.stringify({ reply: 'forged' }), lease, epoch, token, wrong), /authority mismatch/);
const valid = { ...meta, attemptId: claim.attemptId, claimRecordHash: claim.recordHash, contentHash: claim.contentHash, executionPath: 'model' };
const firstTerminal = journal.ack(root, first.eventId, JSON.stringify({ reply: 'real' }), lease, epoch, token, valid);
assert.equal(firstTerminal.executionPath, 'model');
assert.throws(() => journal.ack(root, second.eventId, JSON.stringify({ reply: 'cross-event' }), lease, epoch, token, valid), /authority mismatch|unknown ingress/);

// A dead worker may be recovered once after its lease expires, under a new attempt.
const recovery = secondClaim;
assert.notEqual(recovery.attemptId, claim.attemptId);
const recoveryAuth = { ...meta, workerPid: 502, workerStartIdentity: '502:boot-b', attemptId: recovery.attemptId, claimRecordHash: recovery.recordHash, contentHash: recovery.contentHash, executionPath: 'model' };
const secondTerminal = journal.ack(root, second.eventId, JSON.stringify({ reply: 'separate' }), lease, epoch, token, recoveryAuth);
assert.equal(secondTerminal.eventId, second.eventId);

const blockedIngress = journal.appendIngress(root, 'replay bounded directive', 'test', { idempotencyKey: 'attempt-three' });
for (let i = 0; i < 3; i++) { const c = journal.claimNext(root, lease, epoch, token, 1, 3, { ...meta, workerPid: 700 + i, workerStartIdentity: `700:${i}` }); assert.equal(c.eventId, blockedIngress.eventId); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3); }
assert.equal(journal.claimNext(root, lease, epoch, token, 1, 3, meta), null);
const blockedItem = journal.entries(root).byId.get(blockedIngress.eventId);
assert.equal(blockedItem.terminal.blocked, true);
assert.equal(blockedItem.terminal.reason, 'replay-limit-3');
assert.equal(journal.entries(root).records.filter(r => r.eventId === blockedIngress.eventId && r.kind === 'fail').length, 1);
const recoveryRecord = journal.repairReplayLimit(root, blockedIngress.eventId, 'operator-retry-after-worker-death', lease, epoch, token);
assert.equal(recoveryRecord.kind, 'replay-recovery');
const reopened = journal.claimNext(root, lease, epoch, token, 1000, 3, { ...meta, workerPid: 701, workerStartIdentity: '701:recovery' });
assert.equal(reopened.eventId, blockedIngress.eventId);

const events = journal.entries(root);
assert.equal(events.byId.get(first.eventId).claims.length, 1);
assert.equal(events.byId.get(first.eventId).renewals.length, 1);
assert.equal(events.byId.get(first.eventId).terminal.recordHash, firstTerminal.recordHash);
assert.equal(events.byId.get(second.eventId).terminal.recordHash, secondTerminal.recordHash);
lease.release();
console.log(JSON.stringify({ ok: true, claims: 2, renewals: 1, terminals: 2, root }));
