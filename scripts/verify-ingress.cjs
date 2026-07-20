'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const journal = require('../ingress-journal.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ingress-'));
const modulePath = require.resolve('../ingress-journal.cjs');
const writer = `const j=require(${JSON.stringify(modulePath)}); j.appendIngress(process.argv[1], process.argv[2], 'concurrent-writer');`;
const writerPromises = [];
for (let i = 0; i < 100; i++) {
  writerPromises.push(new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', writer, dir, `directive-${i}-${'x'.repeat(i % 17)}`], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${i} exited ${code}`)));
  }));
}
Promise.all(writerPromises).then(() => {
  runAssertions();
}).catch(error => { console.error(error); process.exitCode = 1; });

function runAssertions() {
let records = journal.readJournal(dir);
const ingress = records.filter(record => record.kind === 'ingress');
assert.equal(ingress.length, 100);
assert.deepEqual(ingress.map(record => record.seq), Array.from({ length: 100 }, (_, i) => i + 1));
assert.equal(new Set(ingress.map(record => record.directiveId)).size, 100);

const legacy = path.join(dir, 'say-inbox'); fs.writeFileSync(legacy, 'legacy-3060-' + 'z'.repeat(3050));
const legacyRecord = journal.reconcileLegacy(dir, legacy, 'legacy-say-inbox');
assert.equal(Buffer.byteLength(journal.getIngress(dir, legacyRecord.directiveId).text), 3062);
assert.equal(fs.existsSync(legacy), true);

const direct = journal.appendIngress(dir, 'journal-directive', 'direct-journal');
const claim = journal.claimNext(dir, 'witness', 7);
assert.equal(claim.directiveId, ingress[0].directiveId);
const oldClaim = journal.claimNext(dir, 'witness-restart', 8);
assert.equal(oldClaim.directiveId, ingress[0].directiveId);
const result = journal.ack(dir, claim.directiveId, 'one durable reply', 'witness-restart', 8);
assert.equal(journal.terminal(dir, claim.directiveId).recordHash, result.recordHash);
assert.equal(journal.claimNext(dir, 'witness-after-ack', 9).directiveId, ingress[1].directiveId);

const journalPath = journal.paths(dir).journal;
fs.appendFileSync(journalPath, '{"kind":"ingress"');
const recovered = journal.readJournal(dir);
assert.equal(recovered.length, records.length + 6);
assert.equal(journal.readJournal(dir).length, recovered.length);
assert(fs.existsSync(journal.paths(dir).quarantine));
console.log(JSON.stringify({ ok: true, dir, writers: 100, recoveredBytes: Buffer.byteLength(journal.getIngress(dir, legacyRecord.directiveId).text), hashes: { legacy: legacyRecord.contentHash, ack: result.recordHash }, replayedClaim: oldClaim.recordHash, tornTailQuarantined: true }));
}
