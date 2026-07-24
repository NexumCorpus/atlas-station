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
  assert.equal(rde.receipt.verdict, 'pass');
  assert.match(boundary.receipt.recordHash, /^sha256:[0-9a-f]{64}$/);
  for (const key of ['artifactHash', 'rdeRunId', 'frozenBarHash', 'claimCheckerHash', 'holdoutFamilyHash', 'auditBundleHash', 'adapterSourceHash', 'preregistrationCommit']) {
    assert.ok(rde.receipt[key], `missing RDE binding ${key}`);
  }
  assert.equal(rde.receipt.measurements.trial.informationGainBits, 1);
  assert.equal(rde.receipt.measurements.holdout.informationGainBits, 1);
  assert.deepEqual(Object.values(rde.receipt.measurements.baselines).map(value => value.informationGainBits), [0, 0, 0, 0]);

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

  const rdeBundle = receipts.rdeBundle(result, expected.evidenceAnchors, expected.holdoutAnchors);
  const repeat = receipts.runVerifier('rde-xenosoma-v1', rdeBundle);
  const stable = value => { const copy = { ...value }; delete copy.nonce; delete copy.issuedAt; delete copy.expiry; delete copy.recordHash; return copy; };
  assert.deepEqual(stable(repeat), stable(rde.receipt));

  const fakeClaims = path.join(memDir, 'fake-claims.json');
  fs.writeFileSync(fakeClaims, JSON.stringify({ adaptive: 'beats_human', overfit: false }));
  const forged = receipts.runVerifier('rde-xenosoma-v1', { ...rdeBundle, rdeEvidence: { claimsPath: fakeClaims, runId: 'fake-run', auditHash: 'sha256:' + '0'.repeat(64) } });
  assert.equal(forged.verdict, 'fail');
  assert.ok(forged.falsifiers.includes('caller-supplied-evidence-forbidden'));
  const callerState = receipts.runVerifier('rde-xenosoma-v1', { ...rdeBundle, claimsPath: fakeClaims, runId: 'caller-run', seeds: [1, 2], measurements: { verdict: 'pass' }, verdict: 'pass' });
  assert.equal(callerState.verdict, 'fail');
  assert.ok(callerState.falsifiers.some(reason => reason.startsWith('caller-fields-forbidden:')));

  const hidden = receipts.runVerifier('rde-xenosoma-v1', { ...rdeBundle, causalArtifact: { ...rdeBundle.causalArtifact, hiddenLabels: ['alpha', 'beta'] } });
  assert.equal(hidden.verdict, 'fail');
  assert.ok(hidden.falsifiers.includes('artifact-toggle-invalid'));

  const managedClaims = path.join('E:/recursive-discovery-engine/runs/xenosoma-receipts', repeat.rdeRunId, 'claims.json');
  const originalClaims = fs.readFileSync(managedClaims, 'utf8');
  fs.writeFileSync(managedClaims, originalClaims.replace('"status":"pass"', '"status":"fail"'));
  const edited = receipts.runVerifier('rde-xenosoma-v1', rdeBundle);
  assert.equal(edited.verdict, 'fail');
  assert.ok(edited.falsifiers.includes('managed-run-state-tampered'));
  fs.writeFileSync(managedClaims, originalClaims);

  const replay = receipts.validateReceipt(rde.receipt, { ...expected, experimentHash: 'sha256:' + 'f'.repeat(64) });
  assert.ok(replay.problems.includes('experimentHash-mismatch'));
  const stale = receipts.validateReceipt({ ...rde.receipt, verifierSourceHead: '0'.repeat(40) }, expected);
  assert.ok(stale.problems.includes('stale-verifier-head'));

  console.log(JSON.stringify({ valid: ['boundary', 'rde'], tamper: 'rejected', staleHead: stale.problems, replay: replay.problems, alteredAnchors: 'rejected', expired: 'rejected', selfIssued: 'rejected', boundaryFail: fail.falsifiers, rdeFalsifiers: rde.receipt.falsifiers, forgedClaims: forged.falsifiers, hiddenLabels: hidden.falsifiers, editedRun: edited.falsifiers, repeatVerdictFieldsStable: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
