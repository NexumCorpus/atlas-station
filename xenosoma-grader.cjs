'use strict';
const crypto = require('crypto');
const loop = require('./decision-loop.cjs');

// Independent grader: reconstructs truth from the seed only; it does not
// generate worlds or select evidence and can be run as a separate process.
function grade(seed, observation) {
  const expected = ((seed * 17 + 3) % 11) >= 6;
  return { fullPass: observation.fullPrediction === expected, minimumPass: observation.minimumPrediction === expected, expected,
    evidenceAnchor: loop.textAnchor({ seed, expected, observation }) };
}
module.exports = { grade };
