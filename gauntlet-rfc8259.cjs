'use strict';

const { digest, trialSeed } = require('./gauntlet-protocol.cjs');

function lexical(seed, index) {
  const cases = [
    [' true ', true], ['TRUE', false], ['-0.25e+2', true], ['01', false],
    ['"\\u0061"', true], [`"${String.fromCharCode(1)}"`, false], ['null', true], ['NaN', false],
  ];
  return cases[(parseInt(seed.slice(0, 8), 16) + index) % cases.length];
}

function structural(seed, index) {
  const cases = [
    ['{"a":[1,false,null]}', true], ['{"a":1,}', false], ['"scalar"', true], ['true false', false],
    [' [ {"x":[]} ] ', true], ["{'x':1}", false], ['[]', true], ['[1,]', false],
  ];
  return cases[((parseInt(seed.slice(-8), 16) ^ index) >>> 0) % cases.length];
}

const families = Object.freeze({ lexical, structural });

function descriptors() {
  return Object.entries(families).map(([id, fn]) => ({ id: `rfc8259-${id}`, version: '1', implementationHash: digest(fn.toString()) }));
}

function claimSpec() {
  return {
    claim: { statement: 'Node.js JSON.parse matches the selected RFC 8259 accept/reject cases', subject: 'JSON.parse', standard: 'RFC 8259' },
    evidenceBoundary: { specification: 'https://www.rfc-editor.org/rfc/rfc8259', sections: ['2', '3', '4', '5', '6', '7'], runtime: process.version },
    lossRule: { kind: 'all-derived-cases-match-expected-acceptance', failureUnit: 'one mismatched parser verdict' },
    generators: descriptors(),
  };
}

function run(frozen, seeded, trialCount = 16) {
  if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 64) throw new Error('trialCount must be 1 through 64');
  const actualDescriptors = descriptors();
  if (digest(frozen.spec.generators) !== digest(actualDescriptors)) throw new Error('frozen RFC 8259 generator implementation mismatch');
  const trials = [];
  for (const descriptor of actualDescriptors) {
    const fn = families[descriptor.id.replace('rfc8259-', '')];
    for (let index = 0; index < trialCount; index += 1) {
      const seed = trialSeed(frozen, seeded, descriptor.id, index);
      const [input, expectedAccepted] = fn(seed, index);
      let actualAccepted = true;
      try { JSON.parse(input); } catch { actualAccepted = false; }
      trials.push({
        trialId: digest(`${descriptor.id}:${index}:${seed}`).slice(0, 24), generatorId: descriptor.id, index, seed,
        input, inputHash: digest(input), expectedAccepted, actualAccepted, pass: expectedAccepted === actualAccepted,
      });
    }
  }
  const core = { schema: 1, state: 'RUN', freezeDigest: frozen.freezeDigest, seededDigest: seeded.seededDigest, pulseIndex: seeded.source.pulseIndex, trials };
  return { ...core, runDigest: digest(core) };
}

function verifyRun(frozen, seeded, artifact) {
  if (!Array.isArray(artifact?.trials) || artifact.trials.length % descriptors().length !== 0) return false;
  const trialCount = artifact.trials.length / descriptors().length;
  if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 64) return false;
  const expected = run(frozen, seeded, trialCount);
  return digest(expected) === digest(artifact);
}

module.exports = { descriptors, claimSpec, run, verifyRun };
