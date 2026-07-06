'use strict';
const { gradeBundle } = require('../grader.cjs');
const path = require('path');
const bundleDir = path.join(__dirname, '..', 'claims', 'boundary-crossing');
const holdoutSeeds = [3, 4]; // committed before fix was written; see holdout.json

async function main() {
  console.log('Running THE GATE on boundary validation claim...');
  console.log('Bundle:', bundleDir);
  console.log('Holdout seeds:', holdoutSeeds, '(committed before fix was written)');
  console.log('');
  try {
    const verdict = await gradeBundle(bundleDir, { holdoutSeeds });
    console.log('Verdict:', verdict.verdict);
    console.log('Reason:', verdict.reason || '(none)');
    if (verdict.stages) {
      for (const [stage, info] of Object.entries(verdict.stages)) {
        console.log('Stage', stage + ':', JSON.stringify(info).slice(0, 120));
      }
    }
    process.exit(verdict.verdict === 'certified' ? 0 : 1);
  } catch(e) {
    console.error('gradeBundle error:', e.message);
    process.exit(1);
  }
}
main();
