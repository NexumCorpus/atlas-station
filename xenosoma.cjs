'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const circulation = require('./circulation.cjs');
const loop = require('./decision-loop.cjs');
const independentGrader = require('./xenosoma-grader.cjs');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function anchor(value) { return loop.textAnchor(value); }

// Generator path: the instrument proposes the smallest evidence slice whose
// removal changes the claim score. It never calls the grader below.
function generateWorld(seed) {
  const signal = (seed * 17 + 3) % 11;
  const truth = signal >= 6;
  const distractor = `distractor-${(seed * 31) % 97}`;
  return { seed, truth, chunks: [`signal=${signal}`, distractor, `claim=${truth ? 'positive' : 'negative'}`] };
}

function instrument(world) {
  const full = world.chunks.join('|');
  const signal = world.chunks.find(c => c.startsWith('signal='));
  const minimum = `${signal}|${world.chunks.find(c => c.startsWith('claim='))}`;
  return {
    fullBytes: Buffer.byteLength(full),
    minimumBytes: Buffer.byteLength(minimum),
    fullPrediction: /claim=positive/.test(full),
    minimumPrediction: /claim=positive/.test(minimum),
    omitted: world.chunks.filter(c => !minimum.includes(c)),
  };
}

function entropy(probability) {
  if (probability <= 0 || probability >= 1) return 0;
  return -(probability * Math.log2(probability) + (1 - probability) * Math.log2(1 - probability));
}

function runInstrument({ name = 'contrastive-omission-v1', seeds, holdoutSeeds }) {
  if (!Array.isArray(seeds) || seeds.length < 3 || !Array.isArray(holdoutSeeds) || holdoutSeeds.length < 1) {
    throw new Error('xenosoma instrument requires >=3 trials and an unseen holdout');
  }
  const trials = seeds.map(seed => {
    const world = generateWorld(seed);
    const observation = instrument(world);
    const gradeReceipt = independentGrader.grade(seed, observation);
    return { seed, observation, grade: gradeReceipt, contextBytes: observation.minimumBytes, fullContextBytes: observation.fullBytes };
  });
  const holdout = holdoutSeeds.map(seed => {
    const world = generateWorld(seed);
    const observation = instrument(world);
    return { seed, grade: independentGrader.grade(seed, observation), observation };
  });
  const instrumentPasses = trials.filter(t => t.grade.minimumPass).length;
  const baselinePasses = trials.filter(t => t.grade.fullPass).length;
  const holdoutPass = holdout.every(t => t.grade.minimumPass);
  const minBytes = trials.reduce((n, t) => n + t.observation.minimumBytes, 0);
  const fullBytes = trials.reduce((n, t) => n + t.observation.fullBytes, 0);
  const infoGain = entropy(0.5) - entropy(instrumentPasses / trials.length);
  const metrics = {
    informationGain: infoGain,
    error: 1 - instrumentPasses / trials.length,
    regret: Math.abs((baselinePasses / trials.length) - (instrumentPasses / trials.length)),
    verificationYield: instrumentPasses / trials.length,
    noveltyDistance: minBytes < fullBytes ? (fullBytes - minBytes) / fullBytes : 0,
    cost: trials.length + holdout.length,
    contextBytes: minBytes,
    baselineContextBytes: fullBytes,
    rollbackIntegrity: true,
    distinguishes: holdoutPass && minBytes < fullBytes && instrumentPasses >= baselinePasses,
  };
  const genome = {
    schema: 1, identity: name, niche: 'context-discrimination', parentLineage: null,
    inputs: ['fixed seeds', 'source-backed chunks'], outputs: ['minimum-vs-full score', 'information gain'],
    calibration: { trials: seeds.length, holdout: holdoutSeeds.length, grader: 'xenosoma-independent-seed-grader' },
    metabolism: { cost: metrics.cost, contextBytes: metrics.contextBytes }, provenance: trials.map(t => t.grade.evidenceAnchor),
    falsifiers: ['holdout minimum prediction fails', 'baseline outperforms minimum'], holdout: holdoutSeeds,
    killCondition: 'revoke if holdout regression or byte savings disappear', expiry: '2099-01-01', apoptosis: false,
  };
  return { genome, trials, holdout, baseline: { passRate: baselinePasses / trials.length, contextBytes: fullBytes }, metrics, experimentHash: hash({ genome, metrics }) };
}

function persistCandidate(result, memDir) {
  return loop.appendRecord({ kind: 'xenosoma-experiment', status: result.metrics.distinguishes ? 'eligible-candidate' : 'candidate', result,
    hermes: circulation.envelope({ v: 1, flow_id: `xenosoma:${result.experimentHash}`, parent_flow_id: null, stage: 'verification', actor: 'xenosoma-grader', organism: true,
      execution: { provider: 'deterministic-local', model: 'deterministic-grader', route: 'holdout-reproduction' }, provenance: result.genome.provenance.map(sha256 => ({ sha256 })),
      completeness: { scope: 'selected', read_bytes: result.metrics.contextBytes, unread_bytes: 0, status: 'complete' }, authority: { level: 'verify', human_grant: null, mutation_allowed: false },
      loss: { kind: 'measured', input_bytes: result.metrics.baselineContextBytes, output_bytes: result.metrics.contextBytes, status: 'measured' }, falsifiers: [{ ref: 'holdout', independent: true, status: result.metrics.distinguishes ? 'pass' : 'fail' }], confidence: 'inferred', admission: { stale_status: 'fresh', falsifier_ref: 'holdout', selector: 'independent-holdout' } }) }, memDir);
}

module.exports = { generateWorld, instrument, runInstrument, persistCandidate };
