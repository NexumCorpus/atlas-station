'use strict';
const path = require('path');
const { gradeBundle } = require('../grader.cjs');

const bundleDir = path.join(__dirname, '..', 'claims', 'boundary-adv');
// Adversarial holdout seeds: ZWSP class, genuinely different from null/empty.
// These were committed to holdout.json BEFORE check.mjs was written.
const holdoutSeeds = [3, 4];

(async () => {
  const verdict = await gradeBundle(bundleDir, { holdoutSeeds });
  console.log('\n=== ADVERSARIAL BOUNDARY GATE VERDICT ===');
  console.log('verdict :', verdict.verdict);
  console.log('reason  :', verdict.reason);
  console.log('\nstages:');
  for (const [stage, detail] of Object.entries(verdict.stages || {})) {
    console.log(`  ${stage}: ok=${detail.ok}`);
    if (detail.runs) {
      for (const r of detail.runs) {
        console.log(`    seed=${r.seed} exit=${r.code} | ${r.output.trim().slice(0, 100)}`);
      }
    }
  }
  process.exit(verdict.verdict === 'certified' ? 0 : 1);
})();
