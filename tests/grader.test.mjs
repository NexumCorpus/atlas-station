import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { gradeBundle } = require('../grader.cjs');

// Phase 3 acceptance (IMMUTABLE — the builder must not modify this file).
// The grader gate: a claim certifies only if its bundle (a) is structurally
// complete, (b) REPRODUCES on its own claimed seeds, and (c) survives HOLDOUT
// seeds the claimant did not choose (the RDE v11 lesson: overfit winners die
// on the holdout family). Nothing certifies without a bundle. Rejection
// carries a reason — displayed, never hidden.

const root = mkdtempSync(path.join(tmpdir(), 'grader-'));

function makeBundle(name, artifactPy, claimedSeeds) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'artifact.py'), artifactPy);
  // check: artifact must compute seed*seed; reference computed independently.
  writeFileSync(path.join(dir, 'check.py'), [
    'import sys',
    'from artifact import square',
    'seed = int(sys.argv[1])',
    'sys.exit(0 if square(seed) == seed * seed else 1)',
  ].join('\n'));
  writeFileSync(path.join(dir, 'claim.json'), JSON.stringify({
    statement: `artifact computes square(n) [${name}]`,
    check: ['python', 'check.py', '{seed}'],
    claimed_seeds: claimedSeeds,
  }));
  return dir;
}

// --- a genuine artifact: certifies -----------------------------------------
{
  const dir = makeBundle('genuine', 'def square(n):\n    return n * n\n', [2, 3]);
  const v = await gradeBundle(dir, { holdoutSeeds: [7, 11] });
  assert.strictEqual(v.verdict, 'certified', 'genuine claim must certify: ' + v.reason);
}

// --- overfit artifact: replays its claimed seeds, dies on holdout ----------
{
  const dir = makeBundle('overfit',
    'TABLE = {2: 4, 3: 9}\ndef square(n):\n    return TABLE[n]\n', [2, 3]);
  const v = await gradeBundle(dir, { holdoutSeeds: [7, 11] });
  assert.strictEqual(v.verdict, 'rejected', 'overfit claim must be REJECTED');
  assert.ok(/holdout/i.test(v.reason), 'rejection must name the holdout stage: ' + v.reason);
}

// --- broken artifact: fails its own claimed seeds (reproduction) -----------
{
  const dir = makeBundle('broken', 'def square(n):\n    return n + n\n', [2, 3]);
  const v = await gradeBundle(dir, { holdoutSeeds: [7] });
  assert.strictEqual(v.verdict, 'rejected');
  assert.ok(/reproduc/i.test(v.reason), 'rejection must name reproduction: ' + v.reason);
}

// --- structural failures: no bundle / no claim.json ------------------------
{
  const v1 = await gradeBundle(path.join(root, 'nonexistent'), { holdoutSeeds: [7] });
  assert.strictEqual(v1.verdict, 'rejected', 'missing bundle can never certify');
  const emptyDir = path.join(root, 'empty');
  mkdirSync(emptyDir);
  const v2 = await gradeBundle(emptyDir, { holdoutSeeds: [7] });
  assert.strictEqual(v2.verdict, 'rejected', 'bundle without claim.json can never certify');
}

// --- holdout seeds must actually be unseen ---------------------------------
{
  const dir = makeBundle('lazy', 'def square(n):\n    return n * n\n', [2, 3]);
  const v = await gradeBundle(dir, { holdoutSeeds: [2, 3] });
  assert.strictEqual(v.verdict, 'rejected',
    'holdout seeds overlapping claimed seeds must be rejected as invalid grading');
}

console.log('grader gate: ALL PASS');
process.exit(0);
