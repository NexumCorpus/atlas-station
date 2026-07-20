'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const loop = require('./decision-loop.cjs');
const circulation = require('./circulation.cjs');

function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function publicSurface(seed) { return { seed, observation: 'stable', bytes: 32 }; }
function derivePerturbation(hypotheses) {
  const predictions = new Set(hypotheses.map(h => h.counterfactual));
  if (predictions.size < 2) throw new Error('hypotheses do not diverge under a counterfactual');
  return { action: 'intervene', feature: 'counterfactual-toggle', predictions: hypotheses.map(h => h.counterfactual) };
}
function runBaseline(surface) {
  const started = Date.now();
  return { output: surface.observation, informationGain: 0, intervened: false, bytes: surface.bytes, durationMs: Date.now() - started };
}
function entropy(p) { return p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)); }
function noveltyDistance(perturbation) {
  const baseline = new Set(['observe', 'surface']);
  const intervention = new Set([perturbation.action, perturbation.feature]);
  const union = new Set([...baseline, ...intervention]).size;
  const intersection = [...baseline].filter(token => intervention.has(token)).length;
  return union ? 1 - (intersection / union) : 0;
}

function createGraderSession() {
  const child = spawn(process.execPath, [path.join(__dirname, 'causal-xenosoma-grader.cjs'), '--server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(line));
    }
  });
  child.on('error', error => { while (waiters.length) waiters.shift()({ ok: false, error: error.message }); });
  function request(input) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('causal grader response timeout')), 5000);
      waiters.push(response => { clearTimeout(timer); response.ok === false ? reject(new Error(response.error)) : resolve(response.value); });
      child.stdin.write(`${JSON.stringify(input)}\n`, error => { if (error) { clearTimeout(timer); reject(error); } });
    });
  }
  async function close() {
    if (!child.killed) { try { await request({ mode: 'close' }); } catch (_) {} child.kill(); }
  }
  return { request, close, child, getStderr: () => stderr };
}

function ledgerOrdering(memDir, commitmentRecordHash, perturbationRecordHash) {
  const records = loop.readRecords(memDir);
  const commitment = records.find(record => record.recordHash === commitmentRecordHash && record.kind === 'causal-xenosoma-commitment');
  const perturbation = records.find(record => record.recordHash === perturbationRecordHash && record.kind === 'causal-xenosoma-perturbation');
  return Boolean(commitment && perturbation && perturbation.commitmentRecordHash === commitment.recordHash &&
    Number(commitment.sequence) < Number(perturbation.sequence) && Date.parse(commitment.ts) <= Date.parse(perturbation.ts));
}

async function runCausalExperiment({ name = 'causal-perturbation-v4', seeds = [2, 3, 4, 5], memDir = path.join(__dirname, 'memory') } = {}) {
  if (!Array.isArray(seeds) || seeds.length < 4 || new Set(seeds).size !== seeds.length) throw new Error('causal instrument requires >=4 distinct trials');
  const hypotheses = [
    { id: 'mechanism-alpha', observational: 'stable', counterfactual: 'alpha' },
    { id: 'mechanism-beta', observational: 'stable', counterfactual: 'beta' },
  ];
  const session = createGraderSession();
  try {
    const started = Date.now();
    const commitment = await session.request({ mode: 'commit' });
    if (commitment.kind !== 'commitment' || !/^sha256:[0-9a-f]{64}$/.test(commitment.commitmentHash)) throw new Error('invalid grader commitment');
    const commitmentReceipt = loop.appendRecord({ kind: 'causal-xenosoma-commitment', status: 'committed', commitment, sequence: commitment.sequence, commitmentHash: commitment.commitmentHash }, memDir);
    const perturbation = derivePerturbation(hypotheses);
    const perturbationReceipt = loop.appendRecord({ kind: 'causal-xenosoma-perturbation', status: 'submitted', perturbation, commitmentRecordHash: commitmentReceipt.recordHash, commitmentHash: commitment.commitmentHash, sequence: commitment.sequence + 1 }, memDir);
    const trials = [];
    for (const seed of seeds) {
      const surface = publicSurface(seed);
      const baseline = runBaseline(surface);
      const requestStarted = Date.now();
      const intervention = await session.request({ mode: 'reveal', seed, perturbation, commitmentHash: commitment.commitmentHash });
      intervention.durationMs = Date.now() - requestStarted;
      const posterior = intervention.revealedMechanism === 'alpha' ? [1, 0] : [0, 1];
      trials.push({ seed, surface, baseline, intervention, posterior, evidenceAnchor: hash({ seed, surface, intervention, commitmentHash: commitment.commitmentHash }) });
    }
    const holdoutStarted = Date.now();
    const gradedHoldout = await session.request({ mode: 'reveal', submode: 'holdout', perturbation, commitmentHash: commitment.commitmentHash });
    const holdoutDurationMs = Date.now() - holdoutStarted;
    const commitmentVerified = hash(gradedHoldout.revealedPayload) === commitment.commitmentHash && gradedHoldout.commitmentHash === commitment.commitmentHash &&
      gradedHoldout.revealedPayload.nonce.length === 32 && gradedHoldout.revealedPayload.holdoutSeeds.length === 2;
    const holdout = gradedHoldout.outcomes.map((outcome, index) => {
      const surface = { seed: gradedHoldout.revealedSeeds[index], observation: 'stable', bytes: 32 };
      const measured = { ...outcome, durationMs: holdoutDurationMs, commitmentHash: gradedHoldout.commitmentHash };
      return { holdoutIndex: index, surface, intervention: measured, evidenceAnchor: hash({ holdoutIndex: index, surface, measured, commitmentHash: commitment.commitmentHash }) };
    });
    const trialClasses = new Set(trials.map(t => t.intervention.revealedMechanism));
    const holdoutClasses = new Set(holdout.map(t => t.intervention.output));
    const infoGain = trials.reduce((sum, t) => sum + (entropy(0.5) - entropy(t.posterior[0])), 0) / trials.length;
    const holdoutPass = holdout.every(t => t.intervention.pass && ['alpha', 'beta'].includes(t.intervention.output));
    const metrics = {
      baselineInformationGain: 0, informationGain: infoGain, error: trials.filter(t => !t.intervention.pass).length / trials.length, regret: 0,
      verificationYield: trials.filter(t => t.intervention.pass).length / trials.length, noveltyDistance: noveltyDistance(perturbation), cost: trials.length + holdout.length,
      contextBytes: trials.reduce((n, t) => n + t.surface.bytes, 0), baselineContextBytes: trials.reduce((n, t) => n + t.baseline.bytes, 0), durationMs: Date.now() - started,
      baselineDurationMs: trials.reduce((n, t) => n + t.baseline.durationMs, 0), rollbackIntegrity: true, rollback: { applicable: false, reason: 'read-only disposable micro-world; no persistent mutation' },
      baselineCannotIntervene: true, trialClassDiversity: trialClasses.size, holdoutClassDiversity: holdoutClasses.size,
      commitmentBeforePerturbation: ledgerOrdering(memDir, commitmentReceipt.recordHash, perturbationReceipt.recordHash), commitmentVerified,
      nonceBits: commitment.nonceBits, preRevealSecretAbsent: !Object.hasOwn(commitment, 'nonce') && !Object.hasOwn(commitment, 'mapping') && !Object.hasOwn(commitment, 'holdoutSeeds'),
      distinguishes: commitmentVerified && trialClasses.size === 2 && holdoutClasses.size === 2 && holdoutPass && infoGain > 0,
    };
    const genome = {
      schema: 4, identity: name, niche: 'causal-discrimination', parentLineage: null, inputs: ['observationally identical surface', 'hypothesis disagreement', 'durable pre-intervention commitment'],
      outputs: ['posterior entropy reduction', 'balanced class reproduction'], calibration: { trials: seeds.length, holdout: holdout.length, grader: 'persistent-causal-xenosoma-grader', baseline: 'same-budget-non-intervening', protocol: commitment.protocolVersion },
      metabolism: { cost: metrics.cost, contextBytes: metrics.contextBytes }, provenance: [commitmentReceipt.recordHash, perturbationReceipt.recordHash, commitment.commitmentHash, ...trials.map(t => t.evidenceAnchor)],
      falsifiers: ['trial or holdout class diversity below two', 'baseline gains information', 'commitment is post-hoc or unverifiable', 'hidden secret appears before reveal', 'holdout outcome is not reproduced'],
      holdout: { count: holdout.length, ownedBy: 'persistent-causal-xenosoma-grader' }, killCondition: 'apoptose on class collapse, commitment mismatch, ordering failure, or hidden-mechanism leakage', expiry: '2099-01-01', apoptosis: false,
    };
    return { genome, hypotheses, perturbation, commitment, commitmentRecordHash: commitmentReceipt.recordHash, perturbationRecordHash: perturbationReceipt.recordHash, trials, holdout, metrics, experimentHash: hash({ genome, hypotheses, perturbation, commitment, trials, holdout, metrics }) };
  } finally { await session.close(); }
}

async function commitOnly({ memDir = path.join(__dirname, 'memory'), seeds = [2, 3, 4, 5] } = {}) {
  const session = createGraderSession();
  try {
    const commitment = await session.request({ mode: 'commit' });
    return loop.appendRecord({ kind: 'causal-xenosoma-commitment', status: 'committed-crash-test', commitment, sequence: commitment.sequence, commitmentHash: commitment.commitmentHash }, memDir);
  } finally { session.child.kill(); }
}

function persistCandidate(result, memDir) {
  const anchors = result.trials.map(t => t.evidenceAnchor);
  const circulationReceipt = circulation.envelope({ v: 1, flow_id: `xenosoma:${result.experimentHash}`, parent_flow_id: null, stage: 'verification', actor: 'persistent-causal-xenosoma-grader', provenance: anchors.map(sha256 => ({ sha256 })), completeness: { scope: 'selected', read_bytes: result.metrics.contextBytes, unread_bytes: 0, status: 'complete' }, authority: { level: 'verify', human_grant: null, mutation_allowed: false }, loss: { kind: 'none', input_bytes: result.metrics.contextBytes, output_bytes: result.metrics.contextBytes, status: 'measured' }, falsifiers: [{ ref: 'causal-holdout', independent: true, status: result.metrics.distinguishes ? 'pass' : 'fail' }], confidence: result.metrics.distinguishes ? 'inferred' : 'unknown' }, 'verification', 'persistent-causal-xenosoma-grader');
  return loop.appendRecord({ kind: 'causal-xenosoma-experiment', status: 'eligible-candidate', experimentHash: result.experimentHash, genome: result.genome, metrics: result.metrics, evidenceAnchors: anchors, holdoutAnchors: result.holdout.map(t => t.evidenceAnchor), commitmentRecordHash: result.commitmentRecordHash, perturbationRecordHash: result.perturbationRecordHash, circulation: circulationReceipt, generator: 'causal-xenosoma-instrument', grader: 'persistent-causal-xenosoma-grader' }, memDir);
}

module.exports = { publicSurface, derivePerturbation, runCausalExperiment, commitOnly, persistCandidate, ledgerOrdering };
