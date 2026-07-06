'use strict';
// certify-safequery.cjs — run THE GATE on the safeQuery wrong-shape guard claim
// holdoutSeeds [3, 4] chosen AFTER check.mjs was written (not before)
const { gradeBundle } = require('../grader.cjs');
const path = require('path');

const bundleDir = path.join(__dirname, '..', 'claims', 'safequery-claim');
const holdoutSeeds = [3, 4];

async function main() {
  console.log('Running THE GATE on safeQuery claim...');
  console.log('Bundle:', bundleDir);
  console.log('Holdout seeds:', holdoutSeeds);
  console.log('');
  try {
    const verdict = await gradeBundle(bundleDir, { holdoutSeeds });
    console.log('Verdict:', verdict.verdict);
    console.log('Reason:', verdict.reason || '(none)');
    console.log('Stages:', JSON.stringify(verdict.stages, null, 2));
    process.exit(verdict.verdict === 'certified' ? 0 : 1);
  } catch (e) {
    console.error('gradeBundle error:', e.message);
    process.exit(1);
  }
}

main();
