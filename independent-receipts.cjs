'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = __dirname;
const VERIFIERS = {
  'boundary-xenosoma-v1': { repo: 'E:/boundary', script: 'tools/verify_xenosoma_receipt.py', protocol: 'boundary-xenosoma-receipt-v1' },
  'rde-xenosoma-v1': { repo: 'E:/recursive-discovery-engine', script: 'scripts/verify_xenosoma_receipt.py', protocol: 'rde-causal-xenosoma-v1' },
};

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortValue(value[k])]));
  return value;
}
function canonical(value) { return JSON.stringify(sortValue(value)); }
function recordHash(payload) { return `sha256:${crypto.createHash('sha256').update(canonical(payload)).digest('hex')}`; }
function exactHash(value) { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value); }
function gitHead(repo) { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); }
function artifactValue(bundle) {
  const value = { ...bundle };
  delete value.rdeEvidence;
  delete value.independentReceipts;
  delete value.independentGates;
  return value;
}

function validateReceipt(receipt, expected, now = Date.now()) {
  const problems = [];
  const allowed = VERIFIERS[receipt?.verifier];
  if (!allowed) problems.push('unknown-verifier');
  if (!receipt || receipt.protocolVersion !== allowed?.protocol) problems.push('protocol-mismatch');
  if (receipt?.generator === 'atlas-station') problems.push('self-issued-atlas-receipt');
  if (receipt?.generator === receipt?.verifier) problems.push('generator-verifier-overlap');
  if (!exactHash(receipt?.experimentHash) || receipt.experimentHash !== expected.experimentHash) problems.push('experimentHash-mismatch');
  for (const key of ['commitmentRecordHash', 'perturbationRecordHash']) if (!exactHash(receipt?.[key]) || receipt[key] !== expected[key]) problems.push(`${key}-mismatch`);
  const anchors = Array.isArray(receipt?.evidenceAnchors) ? receipt.evidenceAnchors : [];
  if (JSON.stringify(anchors) !== JSON.stringify([...expected.evidenceAnchors].sort())) problems.push('evidence-anchors-mismatch');
  if (!Array.isArray(receipt?.holdoutAnchors) || JSON.stringify(receipt.holdoutAnchors) !== JSON.stringify([...expected.holdoutAnchors].sort())) problems.push('holdout-anchors-mismatch');
  if (typeof receipt?.nonce !== 'string' || receipt.nonce.length < 32) problems.push('nonce-too-short');
  if (!receipt?.verifierSourceHead || receipt.verifierSourceHead !== (allowed ? gitHead(allowed.repo) : null)) problems.push('stale-verifier-head');
  if (receipt?.verifier === 'rde-xenosoma-v1') {
    if (!exactHash(receipt.artifactHash) || receipt.artifactHash !== expected.artifactHash) problems.push('artifactHash-mismatch');
    for (const key of ['frozenBarHash', 'claimCheckerHash', 'holdoutFamilyHash', 'auditBundleHash']) {
      if (!exactHash(receipt[key])) problems.push(`${key}-invalid`);
    }
    if (!receipt.preregistrationCommit || !/^[0-9a-f]{40}$/.test(receipt.preregistrationCommit)) problems.push('preregistration-commit-invalid');
    if (!exactHash(receipt.adapterSourceHash)) problems.push('adapter-source-hash-invalid');
    if (!receipt.rdeRunId || typeof receipt.rdeRunId !== 'string') problems.push('rde-run-id-missing');
    if (!receipt.frozenBarVersion || receipt.claimCheckerResult !== true) problems.push('claim-checker-failed');
    const measurements = JSON.stringify(receipt.measurements || {});
    if (/claimsPath|rdeEvidence|recommended_grade|auditHash|runId/.test(measurements)) problems.push('caller-evidence-in-receipt');
  }
  const issued = Date.parse(receipt?.issuedAt); const expiry = Date.parse(receipt?.expiry);
  if (!Number.isFinite(issued) || !Number.isFinite(expiry) || expiry <= issued || expiry < now || issued > now + 60000) problems.push('freshness-or-expiry');
  const unsigned = { ...receipt }; delete unsigned.recordHash;
  if (!exactHash(receipt?.recordHash) || recordHash(unsigned) !== receipt.recordHash) problems.push('recordHash-invalid');
  return { ok: problems.length === 0, problems, receipt };
}

function runVerifier(verifier, bundle) {
  const spec = VERIFIERS[verifier];
  if (!spec) throw new Error(`unknown verifier ${verifier}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenosoma-receipt-'));
  const file = path.join(dir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(bundle), 'utf8');
  const out = execFileSync(process.env.PYTHON || 'python', [path.join(spec.repo, spec.script), file], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function rdeBundle(result, evidenceAnchors, holdoutAnchors) {
  return {
    causalArtifact: {
      surface: { observation: 'stable', bytes: 32 },
      toggle: { feature: 'counterfactual-toggle', states: ['alpha', 'beta'] },
    },
    experimentHash: result.experimentHash,
    commitmentRecordHash: result.commitmentRecordHash,
    perturbationRecordHash: result.perturbationRecordHash,
    evidenceAnchors: [...evidenceAnchors].sort(),
    holdoutAnchors: [...holdoutAnchors].sort(),
    generator: 'causal-xenosoma-instrument',
    grader: 'persistent-causal-xenosoma-grader',
  };
}

function verifyBundle(result, options = {}) {
  const evidenceAnchors = result.evidenceAnchors || result.trials.map(t => t.evidenceAnchor);
  const holdoutAnchors = result.holdoutAnchors || result.holdout.map(t => t.evidenceAnchor);
  const bundle = { ...result, evidenceAnchors, holdoutAnchors, generator: 'causal-xenosoma-instrument', grader: 'persistent-causal-xenosoma-grader' };
  const rde = rdeBundle(result, evidenceAnchors, holdoutAnchors);
  const expected = { experimentHash: result.experimentHash, commitmentRecordHash: result.commitmentRecordHash, perturbationRecordHash: result.perturbationRecordHash, evidenceAnchors, holdoutAnchors, artifactHash: recordHash(artifactValue(rde)) };
  const receipts = {};
  for (const verifier of ['boundary-xenosoma-v1', 'rde-xenosoma-v1']) {
    const receipt = options.receipts?.[verifier] || runVerifier(verifier, verifier === 'rde-xenosoma-v1' ? rde : bundle);
    receipts[verifier] = validateReceipt(receipt, expected);
  }
  return { receipts, expected };
}

module.exports = { canonical, recordHash, validateReceipt, runVerifier, verifyBundle, VERIFIERS, rdeBundle };
