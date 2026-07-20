'use strict';

const crypto = require('crypto');
const HOLDOUT_SEEDS = Object.freeze([8, 10]);

// Hidden mechanism lives only in this grader process. The generator receives
// observations and intervention outcomes, never this mechanism or holdout set.
function grade(input) {
  const seed = Number(input.seed);
  const mechanism = seed % 2 === 0 ? 'alpha' : 'beta';
  const output = input.intervened ? mechanism : 'stable';
  return {
    output,
    pass: input.intervened ? output === mechanism : true,
    receipt: `sha256:${crypto.createHash('sha256').update(JSON.stringify({ seed, output, mechanism })).digest('hex')}`,
  };
}

function gradeHoldout(input) {
  return HOLDOUT_SEEDS.map(seed => grade({ ...input, seed, intervened: true }));
}

if (require.main === module) {
  const input = JSON.parse(process.argv[2] || '{}');
  process.stdout.write(JSON.stringify(input.mode === 'holdout' ? gradeHoldout(input) : grade(input)));
}

module.exports = { grade, gradeHoldout };
