'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const modulePath = require.resolve('../mouth-cancellations.cjs');
const ledger = () => require('../mouth-cancellations.cjs');

function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mouth-cancel-'));
  try {
    const id = 'submission:durable-1';
    const first = ledger().request(root, id, { requestedBy: 'renderer', reason: 'operator stop' });
    assert.equal(first.outcome, 'requested');
    assert.equal(first.requested, true);
    assert.equal(first.consumed, false);

    const duplicate = ledger().request(root, id, { requestedBy: 'renderer' });
    assert.equal(duplicate.outcome, 'existing');
    assert.equal(ledger().readRecords(root).length, 1, 'duplicate stop must not create duplicate request evidence');

    const moduleLiteral = JSON.stringify(modulePath);
    const rootLiteral = JSON.stringify(root);
    const idLiteral = JSON.stringify(id);
    await Promise.all(Array.from({ length: 8 }, (_, index) => runChild(
      `const store=require(${moduleLiteral}); const result=store.consumeOrObserve(${rootLiteral}, ${idLiteral}, {consumer:'sidecar-${index}'}); if(!['consumed','observed'].includes(result.outcome)) process.exit(2);`,
    )));

    const records = ledger().readRecords(root);
    assert.equal(records.filter(record => record.kind === 'request').length, 1);
    assert.equal(records.filter(record => record.kind === 'consume').length, 1, 'concurrent consumers must produce one authoritative consume receipt');

    delete require.cache[modulePath];
    const restarted = ledger().query(root, id);
    assert.equal(restarted.requested, true, 'restart must retain request evidence');
    assert.equal(restarted.consumed, true, 'restart must retain consumption evidence');
    assert.equal(restarted.records.length, 2, 'evidence is append-only, not deleted on consume');
    assert.equal(ledger().consumeOrObserve(root, id, { consumer: 'restarted-sidecar' }).outcome, 'observed');
    assert.equal(ledger().readRecords(root).length, 2, 'observation must not churn the ledger');

    assert.throws(() => ledger().request(root, '../not-a-submission'), /submissionId/);
    assert.throws(() => ledger().query(root, 'x'.repeat(193)), /submissionId/);
    console.log('mouth cancellation ledger: ALL PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
