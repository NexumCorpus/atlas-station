'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 'causal-xenosoma-commit-v2';
const TRIAL_SEEDS = Object.freeze([2, 3, 4, 5]);
const HOLDOUT_SEEDS = Object.freeze([8, 9]);
const HIDDEN_MAPPING = Object.freeze({ 2: 'alpha', 3: 'beta', 4: 'alpha', 5: 'beta', 8: 'alpha', 9: 'beta' });

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function hiddenPayload() {
  return { protocolVersion: PROTOCOL_VERSION, mapping: HIDDEN_MAPPING, holdoutSeeds: HOLDOUT_SEEDS };
}

function commitment() {
  const committedAt = new Date().toISOString();
  const payload = hiddenPayload();
  return {
    kind: 'commitment', protocolVersion: PROTOCOL_VERSION,
    commitmentHash: digest(payload), sequence: 1, committedAt,
    trialCorpus: TRIAL_SEEDS.length, holdoutCorpus: HOLDOUT_SEEDS.length,
  };
}

function reveal(input) {
  const expected = digest(hiddenPayload());
  if (input.commitmentHash !== expected) throw new Error('commitment mismatch');
  const revealedAt = new Date().toISOString();
  if (input.submode === 'holdout') {
    return {
      kind: 'reveal', mode: 'holdout', protocolVersion: PROTOCOL_VERSION,
      commitmentHash: expected, sequence: 2, revealedAt,
      revealedSeeds: HOLDOUT_SEEDS,
      revealedMapping: Object.fromEntries(HOLDOUT_SEEDS.map(seed => [seed, HIDDEN_MAPPING[seed]])),
      revealedPayload: hiddenPayload(),
      outcomes: HOLDOUT_SEEDS.map(seed => ({ seed, output: HIDDEN_MAPPING[seed], pass: true })),
    };
  }
  const seed = Number(input.seed);
  if (!TRIAL_SEEDS.includes(seed)) throw new Error('seed outside committed trial corpus');
  if (!input.perturbation || input.perturbation.action !== 'intervene') throw new Error('intervention required after commitment');
  return {
    kind: 'reveal', mode: 'trial', protocolVersion: PROTOCOL_VERSION,
    commitmentHash: expected, sequence: 2, revealedAt, seed,
    revealedMechanism: HIDDEN_MAPPING[seed], output: HIDDEN_MAPPING[seed], pass: true,
    receipt: digest({ expected, seed, perturbation: input.perturbation, output: HIDDEN_MAPPING[seed] }),
  };
}

function main(input) {
  if (input.mode === 'commit') return commitment();
  if (input.mode === 'reveal') return reveal(input);
  throw new Error('two-phase protocol requires commit or reveal');
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(main(JSON.parse(process.argv[2] || '{}')))); }
  catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}

module.exports = { main, commitment, reveal };
