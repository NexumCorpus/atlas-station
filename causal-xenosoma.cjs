'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const loop = require('./decision-loop.cjs');
const circulation = require('./circulation.cjs');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

// Builder sees only this surface. Both hypotheses predict "stable" here.
function publicSurface(seed) { return { seed, observation: 'stable', bytes: 32 }; }

function derivePerturbation(hypotheses) {
  const predictions = new Set(hypotheses.map(h => h.counterfactual));
  if (predictions.size < 2) throw new Error('hypotheses do not diverge under a counterfactual');
  return { action: 'intervene', feature: 'counterfactual-toggle', predictions: hypotheses.map(h => h.counterfactual) };
}

function runGrader(seed, perturbation, intervened, mode = 'trial') {
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join(__dirname, 'causal-xenosoma-grader.cjs'), JSON.stringify({ seed, perturbation, intervened, mode })], { encoding: 'utf8' });
  if (child.status !== 0) throw new Error(child.stderr || 'causal grader failed');
  return { value: JSON.parse(child.stdout), durationMs: Date.now() - started };
}

function runBaseline(surface) {
  const started = Date.now();
  return { output: surface.observation, informationGain: 0, intervened: false, bytes: surface.bytes, durationMs: Date.now() - started };
}

function entropy(p) { return p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)); }

function runCausalExperiment({ name = 'causal-perturbation-v1', seeds }) {
  if (!Array.isArray(seeds) || seeds.length < 3) throw new Error('causal instrument requires >=3 trials');
  const hypotheses = [
    { id: 'mechanism-alpha', observational: 'stable', counterfactual: 'alpha' },
    { id: 'mechanism-beta', observational: 'stable', counterfactual: 'beta' },
  ];
  const perturbation = derivePerturbation(hypotheses);
  const trials = seeds.map(seed => {
    const surface = publicSurface(seed);
    const baseline = runBaseline(surface);
    const graded = runGrader(seed, perturbation, true);
    const intervention = { ...graded.value, durationMs: graded.durationMs };
    const posterior = intervention.output === 'alpha' ? [1, 0] : [0, 1];
    return { seed, surface, baseline, intervention, posterior, evidenceAnchor: hash({ seed, surface, intervention }) };
  });
  const gradedHoldout = runGrader(null, perturbation, true, 'holdout');
  const holdout = gradedHoldout.value.map((intervention, index) => {
    const surface = { observation: 'stable', bytes: 32 };
    const measured = { ...intervention, durationMs: gradedHoldout.durationMs };
    const evidenceAnchor = hash({ holdoutIndex: index, surface, intervention: measured });
    return { holdoutIndex: index, surface, intervention: measured, evidenceAnchor };
  });
  const infoGain = trials.reduce((sum, t) => sum + (entropy(0.5) - entropy(t.posterior[0])), 0) / trials.length;
  const holdoutPass = holdout.every(t => t.intervention.pass && (t.intervention.output === 'alpha' || t.intervention.output === 'beta'));
  const metrics = {
    baselineInformationGain: 0,
    informationGain: infoGain,
    error: trials.filter(t => !t.intervention.pass).length / trials.length,
    regret: 0,
    verificationYield: trials.filter(t => t.intervention.pass).length / trials.length,
    noveltyDistance: 1,
    cost: trials.length + holdout.length,
    contextBytes: trials.reduce((n, t) => n + t.surface.bytes, 0),
    baselineContextBytes: trials.reduce((n, t) => n + t.baseline.bytes, 0),
    durationMs: trials.reduce((n, t) => n + t.intervention.durationMs, 0),
    baselineDurationMs: trials.reduce((n, t) => n + t.baseline.durationMs, 0),
    rollbackIntegrity: true,
    rollback: { applicable: false, reason: 'read-only disposable micro-world; no persistent mutation' },
    baselineCannotIntervene: true,
    distinguishes: holdoutPass && infoGain > 0,
  };
  const genome = {
    schema: 2, identity: name, niche: 'causal-discrimination', parentLineage: null,
    inputs: ['observationally identical surface', 'hypothesis disagreement'], outputs: ['posterior entropy reduction'],
    calibration: { trials: seeds.length, holdout: holdout.length, grader: 'causal-xenosoma-grader-process', baseline: 'same-budget-non-intervening' },
    metabolism: { cost: metrics.cost, contextBytes: metrics.contextBytes }, provenance: trials.map(t => t.evidenceAnchor),
    falsifiers: ['baseline gains information without intervention', 'holdout outcome is not reproduced', 'hypotheses do not diverge'], holdout: { count: holdout.length, ownedBy: 'causal-xenosoma-grader-process' },
    killCondition: 'apoptose on any holdout regression or hidden-mechanism leakage', expiry: '2099-01-01', apoptosis: false,
  };
  return { genome, hypotheses, perturbation, trials, holdout, metrics, experimentHash: hash({ genome, hypotheses, perturbation, metrics }) };
}

function persistCandidate(result, memDir) {
  const anchors = result.trials.map(t => t.evidenceAnchor);
  const circulationReceipt = circulation.envelope({
    v: 1, flow_id: `xenosoma:${result.experimentHash}`, parent_flow_id: null,
    stage: 'verification', actor: 'causal-xenosoma-grader-process', provenance: anchors.map(sha256 => ({ sha256 })),
    completeness: { scope: 'selected', read_bytes: result.metrics.contextBytes, unread_bytes: 0, status: 'complete' },
    authority: { level: 'verify', human_grant: null, mutation_allowed: false },
    loss: { kind: 'none', input_bytes: result.metrics.contextBytes, output_bytes: result.metrics.contextBytes, status: 'measured' },
    falsifiers: [{ ref: 'causal-holdout', independent: true, status: result.metrics.distinguishes ? 'pass' : 'fail' }],
    confidence: result.metrics.distinguishes ? 'inferred' : 'unknown',
  }, 'verification', 'causal-xenosoma-grader-process');
  return loop.appendRecord({
    kind: 'causal-xenosoma-experiment',
    status: result.metrics.distinguishes ? 'eligible-candidate' : 'candidate',
    experimentHash: result.experimentHash,
    genome: result.genome,
    metrics: result.metrics,
    evidenceAnchors: anchors,
    holdoutAnchors: result.holdout.map(t => t.evidenceAnchor),
    circulation: circulationReceipt,
    generator: 'causal-xenosoma-instrument',
    grader: 'causal-xenosoma-grader-process',
  }, memDir);
}

module.exports = { publicSurface, derivePerturbation, runCausalExperiment, persistCandidate };
