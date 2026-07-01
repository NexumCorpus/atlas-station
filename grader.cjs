const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Grader gate (Phase 3): independent certification of wing claims.
//
// A claim certifies only if its bundle (a) is structurally complete, (b)
// REPRODUCES on its own claimed seeds, and (c) survives HOLDOUT seeds the
// claimant did not choose — the RDE v11 lesson: overfit winners die on the
// holdout family. Nothing certifies without a bundle; every rejection
// carries a reason for display.
//
// Honest v1 limit: this gate verifies that the DECLARED check generalizes
// past its claimed seeds. The trustworthiness of the check itself is the
// mission harness's responsibility (trusted oracles arrive with Phase 5 /
// RDE evaluators). Generator≠grader at the station level means the claimant
// never runs this code path itself.

const RUN_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 4096;

// Run one check command with "{seed}" substituted, cwd = bundleDir.
function runCheck(check, seed, cwd) {
  const argv = check.map((a) => a.split('{seed}').join(String(seed)));
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, timeout: RUN_TIMEOUT_MS });
    let output = '';
    const collect = (d) => { if (output.length < OUTPUT_CAP) output += d; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ seed, code: -1, output: String(err) }));
    child.on('close', (code, signal) => resolve({
      seed,
      code: code === null ? -1 : code,
      signal: signal || undefined,
      output: output.slice(0, OUTPUT_CAP),
    }));
  });
}

async function runSeeds(check, seeds, cwd) {
  const runs = [];
  for (const seed of seeds) {
    runs.push(await runCheck(check, seed, cwd));
    if (runs[runs.length - 1].code !== 0) break; // first failure decides
  }
  return runs;
}

async function gradeBundle(bundleDir, { holdoutSeeds = [] } = {}) {
  const stages = {};
  const reject = (reason) => ({ verdict: 'rejected', reason, stages });

  // --- structural: bundle exists and claim.json is complete ---------------
  if (!bundleDir || !fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    stages.structural = { ok: false, detail: 'bundle directory missing' };
    return reject(`structural: bundle directory not found: ${bundleDir}`);
  }
  const claimPath = path.join(bundleDir, 'claim.json');
  if (!fs.existsSync(claimPath)) {
    stages.structural = { ok: false, detail: 'claim.json missing' };
    return reject('structural: bundle has no claim.json');
  }
  let claim;
  try {
    claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  } catch (err) {
    stages.structural = { ok: false, detail: 'claim.json unparseable' };
    return reject(`structural: claim.json is not valid JSON (${err.message})`);
  }
  if (typeof claim.statement !== 'string' || !claim.statement) {
    stages.structural = { ok: false, detail: 'statement missing' };
    return reject('structural: claim.json lacks a statement string');
  }
  if (!Array.isArray(claim.check) || claim.check.length === 0 ||
      !claim.check.some((a) => typeof a === 'string' && a.includes('{seed}'))) {
    stages.structural = { ok: false, detail: 'check argv invalid' };
    return reject('structural: claim.check must be an argv array containing a "{seed}" placeholder');
  }
  if (!Array.isArray(claim.claimed_seeds) || claim.claimed_seeds.length === 0) {
    stages.structural = { ok: false, detail: 'claimed_seeds empty' };
    return reject('structural: claim.claimed_seeds must be a non-empty array');
  }
  stages.structural = { ok: true, statement: claim.statement };

  // --- grading validity: holdout must contain genuinely unseen seeds ------
  const claimed = claim.claimed_seeds;
  const unseen = (holdoutSeeds || []).filter((s) => !claimed.includes(s));
  if (unseen.length === 0) {
    stages.validity = { ok: false, detail: 'no unseen holdout seeds' };
    return reject('grading invalid: no genuinely unseen holdout seed (all holdout seeds appear in claimed_seeds)');
  }
  stages.validity = { ok: true, unseen };

  // --- reproduction: the claim must replay on its own seeds ---------------
  const repro = await runSeeds(claim.check, claimed, bundleDir);
  const reproFail = repro.find((r) => r.code !== 0);
  stages.reproduction = { ok: !reproFail, runs: repro };
  if (reproFail) {
    return reject(`reproduction failed on claimed seed ${reproFail.seed} (exit ${reproFail.code})`);
  }

  // --- holdout: it must also survive seeds the claimant did not choose ----
  const hold = await runSeeds(claim.check, unseen, bundleDir);
  const holdFail = hold.find((r) => r.code !== 0);
  stages.holdout = { ok: !holdFail, runs: hold };
  if (holdFail) {
    return reject(`holdout failed on unseen seed ${holdFail.seed} (exit ${holdFail.code}) — claim does not generalize past its claimed seeds`);
  }

  return {
    verdict: 'certified',
    reason: `reproduced on claimed seeds [${claimed.join(', ')}] and survived holdout seeds [${unseen.join(', ')}]`,
    stages,
  };
}

// Claim-path connector: wing-host force-tags every claim verified:false.
// This is the only path that can flip it — and only via a certified bundle.
async function certifyClaim(claimEvent, opts = {}) {
  if (!claimEvent || typeof claimEvent.bundle !== 'string' || !claimEvent.bundle) {
    return { ...claimEvent, verified: false, rejection: 'claim has no bundle — nothing to grade' };
  }
  const verdict = await gradeBundle(claimEvent.bundle, opts);
  if (verdict.verdict === 'certified') {
    return { ...claimEvent, verified: true, certification: verdict.reason, stages: verdict.stages };
  }
  return { ...claimEvent, verified: false, rejection: verdict.reason, stages: verdict.stages };
}

module.exports = { gradeBundle, certifyClaim };
