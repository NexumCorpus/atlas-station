'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 'causal-xenosoma-commit-reveal-v1';
const TRIAL_SEEDS = Object.freeze([2, 3, 4, 5]);

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function randomSeed(used) {
  let seed;
  do seed = crypto.randomInt(100000, 2147483647); while (used.has(seed));
  return seed;
}

function sampleSession(trialSeeds) {
  const used = new Set(trialSeeds);
  const holdoutSeeds = [randomSeed(used), randomSeed(used)];
  function balancedLabels(count) {
    const labels = Array.from({ length: count }, (_, index) => index % 2 === 0 ? 'alpha' : 'beta');
    for (let i = labels.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [labels[i], labels[j]] = [labels[j], labels[i]];
    }
    return labels;
  }
  const trialLabels = balancedLabels(trialSeeds.length);
  const holdoutLabels = balancedLabels(holdoutSeeds.length);
  const mapping = Object.fromEntries([
    ...trialSeeds.map((seed, index) => [seed, trialLabels[index]]),
    ...holdoutSeeds.map((seed, index) => [seed, holdoutLabels[index]]),
  ]);
  const nonce = crypto.randomBytes(16).toString('hex');
  const revealedPayload = { protocolVersion: PROTOCOL_VERSION, trialSeeds, holdoutSeeds, mapping, nonce };
  return { trialSeeds, holdoutSeeds, mapping, nonce, revealedPayload, commitmentHash: digest(revealedPayload) };
}

function validatePerturbation(perturbation) {
  if (!perturbation || perturbation.action !== 'intervene' || perturbation.feature !== 'counterfactual-toggle') {
    throw new Error('instrument must register the counterfactual-toggle intervention');
  }
  const predictions = [...new Set(perturbation.predictions || [])].sort();
  if (predictions.join('|') !== 'alpha|beta') throw new Error('instrument must encode both registered hypotheses');
}

function createSession({ trialSeeds = TRIAL_SEEDS } = {}) {
  if (!Array.isArray(trialSeeds) || trialSeeds.length < 4 || new Set(trialSeeds).size !== trialSeeds.length) throw new Error('balanced trial corpus required');
  const state = { committed: false, revealed: false, sequence: 0, session: null };
  return {
    handle(input) {
      if (input.mode === 'commit') {
        if (state.committed) throw new Error('session already committed');
        const requestedSeeds = Array.isArray(input.trialSeeds) ? input.trialSeeds : trialSeeds;
        state.session = sampleSession(requestedSeeds);
        state.committed = true;
        state.sequence = 1;
        return {
          kind: 'commitment', protocolVersion: PROTOCOL_VERSION,
          commitmentHash: state.session.commitmentHash, sequence: state.sequence,
          committedAt: new Date().toISOString(), trialCorpus: trialSeeds.length,
          holdoutCorpus: state.session.holdoutSeeds.length, nonceBits: 128,
        };
      }
      if (!state.committed) throw new Error('commitment required before reveal');
      if (input.mode !== 'reveal' || input.commitmentHash !== state.session.commitmentHash) throw new Error('commitment mismatch');
      validatePerturbation(input.perturbation);
      if (input.submode === 'holdout') {
        if (state.revealed) throw new Error('session already revealed');
        state.revealed = true;
        state.sequence += 1;
        const revealedAt = new Date().toISOString();
        const outcomes = state.session.holdoutSeeds.map(seed => ({ seed, output: state.session.mapping[seed], pass: true }));
        return { kind: 'reveal', mode: 'holdout', protocolVersion: PROTOCOL_VERSION,
          commitmentHash: state.session.commitmentHash, sequence: state.sequence, revealedAt,
          revealedSeeds: state.session.holdoutSeeds, revealedMapping: Object.fromEntries(state.session.holdoutSeeds.map(seed => [seed, state.session.mapping[seed]])),
          revealedPayload: state.session.revealedPayload, outcomes,
          receipt: digest({ commitmentHash: state.session.commitmentHash, sequence: state.sequence, outcomes, revealedAt }) };
      }
      if (state.revealed) throw new Error('session already revealed');
      const seed = Number(input.seed);
      if (!state.session.trialSeeds.includes(seed)) throw new Error('seed outside committed trial corpus');
      state.sequence += 1;
      const revealedAt = new Date().toISOString();
      const output = state.session.mapping[seed];
      return { kind: 'reveal', mode: 'trial', protocolVersion: PROTOCOL_VERSION,
        commitmentHash: state.session.commitmentHash, sequence: state.sequence, revealedAt, seed,
        revealedMechanism: output, output, pass: true,
        receipt: digest({ commitmentHash: state.session.commitmentHash, sequence: state.sequence, seed, output }) };
    },
  };
}

function server() {
  const session = createSession();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try {
      const input = JSON.parse(line);
      if (input.mode === 'close') { process.stdout.write(JSON.stringify({ kind: 'closed' }) + '\n'); process.stdin.pause(); return; }
      process.stdout.write(JSON.stringify({ ok: true, value: session.handle(input) }) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
    }
  });
}

if (require.main === module && process.argv[2] === '--server') server();

module.exports = { PROTOCOL_VERSION, TRIAL_SEEDS, createSession, digest, validatePerturbation };
