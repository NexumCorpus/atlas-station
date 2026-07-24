'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const j = require('../ingress-journal.cjs');
const leaseModule = require('../sidecar-lease.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ingress-'));
const lease = leaseModule.acquire(dir, 30000);
const modulePath = require.resolve('../ingress-journal.cjs');
const writer = `const j=require(${JSON.stringify(modulePath)}); j.appendIngress(process.argv[1], process.argv[2], 'concurrent-writer');`;

function child(code, args) { return new Promise((resolve, reject) => { const p = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); let error = ''; p.stderr.on('data', chunk => { error += chunk; }); p.once('error', reject); p.once('exit', status => status === 0 ? resolve() : reject(new Error(`child exit ${status}: ${error}`))); }); }

(async () => {
  await Promise.all(Array.from({ length: 100 }, (_, i) => child(writer, [dir, `directive-${i}-${'x'.repeat(i % 17)}`])));
  const first = j.appendIngress(dir, 'same-bytes', 'intentional');
  const second = j.appendIngress(dir, 'same-bytes', 'intentional');
  assert.notEqual(first.eventId, second.eventId, 'identical intentional events get unique ids');
  const retry = j.appendIngress(dir, 'same-bytes', 'intentional', { idempotencyKey: 'retry-1' });
  assert.equal(j.appendIngress(dir, 'same-bytes', 'intentional', { idempotencyKey: 'retry-1' }).eventId, retry.eventId, 'explicit retry key is idempotent');
  assert.throws(() => j.appendIngress(dir, 'changed-bytes', 'intentional', { idempotencyKey: 'retry-1' }), /idempotency key content conflict/);
  assert.throws(() => j.appendIngress(dir, 'different', 'intentional', { eventId: first.eventId }), /event id content conflict/);

  const claimA = j.claimNext(dir, lease, lease.owner.epoch, lease.token, 30000);
  const claimB = j.claimNext(dir, lease, lease.owner.epoch, lease.token, 30000);
  assert.notEqual(claimA.eventId, claimB.eventId, 'critical-section claimers cannot select the same live event');
  const claimC = j.claimNext(dir, lease, lease.owner.epoch, lease.token, 30000);
  assert(![claimA.eventId, claimB.eventId].includes(claimC.eventId), 'live claims are not stolen');
  const expiringClaim = j.claimNext(dir, lease, lease.owner.epoch, lease.token, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  const reclaimedClaim = j.claimNext(dir, lease, lease.owner.epoch, lease.token, 30000);
  assert.equal(reclaimedClaim.eventId, expiringClaim.eventId); assert.equal(reclaimedClaim.replay, true, 'stale claim is reclaimed');
  assert.throws(() => j.ack(dir, claimA.eventId, 'stale', lease, lease.owner.epoch, 'wrong-token'), /stale lease fence/);

  const outbox = path.join(dir, 'outbox.ndjson');
  const published = j.appendOutbox(outbox, { directiveId: claimA.eventId, reply: 'one durable result' });
  const repaired = j.repairPublication(dir, outbox, lease, lease.owner.epoch, lease.token);
  assert.equal(repaired.length, 1, 'outbox-before-ack repairs exactly one journal ack');
  assert.equal(j.repairPublication(dir, outbox, lease, lease.owner.epoch, lease.token).length, 0, 'repaired publication is idempotent');
  const ackB = j.ack(dir, claimB.eventId, JSON.stringify({ reply: 'ack-first' }), lease, lease.owner.epoch, lease.token);
  const duplicateAck = j.ack(dir, claimB.eventId, JSON.stringify({ reply: 'late-model-result' }), lease, lease.owner.epoch, lease.token);
  assert.equal(duplicateAck.recordHash, ackB.recordHash, 'first valid terminal wins');
  assert.equal(j.entries ? j.entries(dir).byId.get(claimB.eventId).terminal.recordHash : j.terminal(dir, claimB.eventId).recordHash, ackB.recordHash);
  j.repairPublication(dir, outbox, lease, lease.owner.epoch, lease.token);
  assert(fs.readFileSync(outbox, 'utf8').includes(claimB.eventId), 'ack result can repair publication');

  const legacy = path.join(dir, 'say-inbox'); fs.writeFileSync(legacy, 'legacy-3060-' + 'z'.repeat(3048));
  const legacyRecord = j.reconcileLegacy(dir, legacy, 'legacy-say-inbox');
  assert.equal(Buffer.byteLength(j.getIngress(dir, legacyRecord.eventId).text), 3060);
  const orphan = `${legacy}.claim.crash-boundary`; fs.writeFileSync(orphan, 'orphan bytes');
  const orphanRecord = j.reconcileLegacy(dir, legacy, 'legacy-say-inbox'); assert.equal(j.getIngress(dir, orphanRecord.eventId).text, 'orphan bytes');

  const journalPath = j.paths(dir).journal;
  function assertPhysicalChain(label) {
    const physical = fs.readFileSync(journalPath, 'utf8').split(/\n/).filter(Boolean).map(line => JSON.parse(line));
    const parsed = j.readJournal(dir);
    assert.equal(physical.length, parsed.length, `${label}: physical rows equal parsed rows`);
    let prior = null;
    physical.forEach((record, index) => {
      const copy = { ...record }; delete copy.recordHash;
      assert.equal(record.recordHash, j.hash(copy), `${label}: record hash ${index + 1}`);
      assert.equal(record.seq, index + 1, `${label}: contiguous seq ${index + 1}`);
      assert.equal(record.priorHash ?? null, prior, `${label}: prior hash ${index + 1}`);
      prior = record.recordHash;
    });
  }
  const salvage = { kind: 'ingress', eventId: 'event:migration-salvage', directiveId: 'event:migration-salvage', contentHash: j.bytesHash('migration payload'), source: 'migration', text: 'migration payload', seq: 999, priorHash: null, ts: new Date().toISOString() }; salvage.recordHash = j.hash(salvage);
  fs.appendFileSync(journalPath, JSON.stringify(salvage) + '\n');
  j.appendIngress(dir, 'post-migration', 'migration');
  assert.equal(j.getIngress(dir, 'event:migration-salvage').text, 'migration payload', 'valid ingress suffix is salvaged and re-ingested');
  assert(fs.existsSync(j.paths(dir).migration), 'migration anchor is durable');
  assertPhysicalChain('after salvage');
  j.appendIngress(dir, 'append-after-recovery', 'migration');
  assertPhysicalChain('after append-after-recovery');
  fs.appendFileSync(journalPath, '{"kind":"corrupt-middle"}\n{"kind":"suffix"}\n');
  const recovered = j.readJournal(dir, true); const raw = fs.readFileSync(journalPath); assert.equal(raw[raw.length - 1], 0x0a); assert(!recovered.some(record => record.kind === 'corrupt-middle')); assert(fs.existsSync(j.paths(dir).quarantine)); assertPhysicalChain('after corrupt-tail repair');
  const anchor = fs.readFileSync(j.paths(dir).migration, 'utf8'); fs.writeFileSync(j.paths(dir).migration, anchor.replace('migration-anchor', 'tampered-anchor')); assert.throws(() => j.readJournal(dir), /migration anchor verification failed/); fs.writeFileSync(j.paths(dir).migration, anchor);
  lease.release();
  console.log(JSON.stringify({ ok: true, dir, writers: 100, uniqueIdenticalEvents: [first.eventId, second.eventId], retryEventId: retry.eventId, claimEvents: [claimA.eventId, claimB.eventId], repairedResult: published.recordHash, repairedAck: repaired[0].recordHash, ackFirst: ackB.recordHash, recoveredBytes: 3060, corruptSuffixQuarantined: true }));
})().catch(error => { try { lease.release(); } catch {} console.error(error); process.exitCode = 1; });
