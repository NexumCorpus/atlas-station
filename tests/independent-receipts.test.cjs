'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const x = require('../causal-xenosoma.cjs');
const receipts = require('../independent-receipts.cjs');

(async () => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenosoma-bridge-'));
  const result = await x.runCausalExperiment({ memDir, allowUnfencedTest: true });
  const boundary = result.independentReceipts['boundary-xenosoma-v1'];
  const rde = result.independentReceipts['rde-xenosoma-v1'];
  assert.equal(boundary.ok, true);
  assert.equal(boundary.receipt.verdict, 'pass');
  assert.equal(rde.ok, true);
  assert.equal(rde.receipt.verdict, 'unknown');
  assert.match(boundary.receipt.recordHash, /^sha256:[0-9a-f]{64}$/);

  const expected = { experimentHash: result.experimentHash, commitmentRecordHash: result.commitmentRecordHash, perturbationRecordHash: result.perturbationRecordHash, evidenceAnchors: result.trials.map(t => t.evidenceAnchor), holdoutAnchors: result.holdout.map(t => t.evidenceAnchor) };
  const tampered = { ...boundary.receipt, verdict: 'fail' };
  assert.equal(receipts.validateReceipt(tampered, expected).ok, false);
  assert.ok(receipts.validateReceipt({ ...boundary.receipt, verifierSourceHead: '0'.repeat(40) }, expected).problems.includes('stale-verifier-head'));
  assert.ok(receipts.validateReceipt({ ...boundary.receipt, experimentHash: 'sha256:' + '1'.repeat(64) }, expected).problems.includes('experimentHash-mismatch'));
  assert.ok(receipts.validateReceipt({ ...boundary.receipt, evidenceAnchors: [...boundary.receipt.evidenceAnchors].reverse() }, expected).problems.includes('evidence-anchors-mismatch'));
  assert.ok(receipts.validateReceipt({ ...boundary.receipt, expiry: new Date(Date.now() - 1000).toISOString() }, expected).problems.includes('freshness-or-expiry'));
  assert.ok(receipts.validateReceipt({ ...boundary.receipt, generator: 'atlas-station', verifierIndependentOf: 'atlas-station' }, expected).problems.includes('self-issued-atlas-receipt'));

  const failBundle = { ...result, metrics: { ...result.metrics, baselineInformationGain: 1 } };
  const fail = receipts.runVerifier('boundary-xenosoma-v1', failBundle);
  assert.equal(fail.verdict, 'fail');
  assert.ok(fail.falsifiers.includes('observational_baseline_zero'));
  console.log(JSON.stringify({ valid: ['boundary'], unknown: ['rde'], tamper: 'rejected', staleHead: 'rejected', replay: 'rejected', alteredAnchors: 'rejected', expired: 'rejected', selfIssued: 'rejected', boundaryFail: fail.falsifiers, rdeNull: rde.receipt.falsifiers }));
})().catch(error => { console.error(error); process.exitCode = 1; });
