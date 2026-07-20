'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function clean(value) { return String(value == null ? '' : value).trim(); }

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function textAnchor(value) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`;
}

function exactAnchor(anchor) {
  return typeof anchor === 'string' && /^sha256:[0-9a-f]{64}$/.test(anchor);
}

function requireText(value, name) {
  const out = clean(value);
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function createDecisionPacket(input = {}) {
  const context = Array.isArray(input.context) ? input.context : [];
  const hypotheses = Array.isArray(input.hypotheses) ? input.hypotheses : [];
  if (context.length < 1) throw new Error('decision packet requires selected context');
  if (context.some(item => !item || !exactAnchor(item.anchor))) {
    throw new Error('every context item requires an exact sha256 anchor');
  }
  if (hypotheses.length < 2) throw new Error('decision packet requires at least two rival hypotheses');
  const ids = new Set(hypotheses.map(h => requireText(h.id, 'hypothesis id')));
  if (ids.size !== hypotheses.length) throw new Error('rival hypothesis ids must be unique');
  const intervention = input.intervention || {};
  if (input.authorized !== true) throw new Error('decision packet requires explicit local authorization');
  if (intervention.external === true || intervention.irreversible === true || intervention.reversible === false) {
    throw new Error('decision packet cannot authorize external or irreversible intervention');
  }
  const prediction = input.prediction || {};
  requireText(prediction.metric, 'prediction metric');
  if (!Number.isFinite(prediction.target)) throw new Error('prediction target is required');
  const packet = {
    schema: 1,
    packetId: requireText(input.packetId, 'packetId'),
    decision: requireText(input.decision, 'decision'),
    context: context.map(item => ({ ref: requireText(item.ref, 'context ref'), anchor: item.anchor })),
    hypotheses: hypotheses.map(h => ({ id: clean(h.id), claim: requireText(h.claim, 'hypothesis claim'), confidence: Number(h.confidence) })),
    intervention: { name: requireText(intervention.name, 'intervention name'), reversible: intervention.reversible !== false, external: false, irreversible: false },
    prediction: { metric: clean(prediction.metric), target: prediction.target, failureCondition: requireText(prediction.failureCondition, 'prediction failureCondition') },
    authority: { level: 'write', mutationAllowed: true, operatorInterrupt: true, scope: 'local-reversible' },
    sourceStatus: input.sourceStatus || 'fresh',
  };
  if (packet.hypotheses.some(h => !Number.isFinite(h.confidence) || h.confidence < 0 || h.confidence > 1)) throw new Error('hypothesis confidence must be between 0 and 1');
  packet.packetHash = hash(packet);
  return packet;
}

function ledgerPath(memDir) { return path.join(memDir, 'decision-loop.ndjson'); }

function appendRecord(record, memDir) {
  fs.mkdirSync(memDir, { recursive: true });
  const body = { ...record, ts: new Date().toISOString() };
  body.recordHash = hash(body);
  const fd = fs.openSync(ledgerPath(memDir), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return body;
}

function readRecords(memDir) {
  const file = ledgerPath(memDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function loadPromotedPolicy(memDir) {
  const records = readRecords(memDir);
  const revokedRecords = records.filter(r => r.status === 'revoked');
  const revoked = new Set(revokedRecords.map(r => r.policyHash));
  const quarantined = new Set(records.filter(r => r.status === 'quarantined').map(r => r.targetRecordHash));
  const promoted = records.filter(r => r.status === 'promoted' && r.policy && !quarantined.has(r.recordHash));
  const active = promoted.filter(r => !revoked.has(r.policy.policyHash));
  const latest = promoted.at(-1);
  if (latest && revoked.has(latest.policy.policyHash)) {
    const rollback = revokedRecords.at(-1)?.rollbackTarget;
    return active.find(r => r.policy.policyHash === rollback)?.policy || active.at(-1)?.policy || null;
  }
  return active.at(-1)?.policy || null;
}

function createExperiment(input = {}) {
  const name = requireText(input.name, 'experiment name');
  const generator = requireText(input.generator, 'experiment generator');
  const grader = requireText(input.grader, 'experiment grader');
  if (generator === grader) throw new Error('experiment generator and grader must be distinct');
  const holdout = Array.isArray(input.holdout) ? input.holdout : [];
  if (holdout.length < 1) throw new Error('experiment requires a holdout');
  const experiment = { schema: 2, experimentId: requireText(input.experimentId, 'experimentId'), name, generator, grader, holdout, trials: [], status: 'candidate' };
  experiment.experimentHash = hash(experiment);
  return experiment;
}

function addTrial(experiment, trial) {
  if (!experiment || !experiment.experimentHash) throw new Error('experiment is required');
  if (!trial || !trial.trialId || !exactAnchor(trial.evidenceAnchor)) throw new Error('trial requires exact evidence anchor');
  const metrics = trial.metrics || {};
  experiment.trials.push({ trialId: trial.trialId, evidenceAnchor: trial.evidenceAnchor, metrics, graderReceipt: requireText(trial.graderReceipt, 'graderReceipt') });
  return experiment;
}

function evaluateExperiment(experiment, holdout) {
  if (experiment.generator === experiment.grader) return { status: 'rejected', reason: 'generator=grader' };
  if (experiment.trials.length < 3) return { status: 'candidate', reason: 'at least three trials required' };
  if (!holdout || holdout.passed !== true || !exactAnchor(holdout.evidenceAnchor)) return { status: 'candidate', reason: 'independent holdout required' };
  const required = ['retrievalUtility', 'verificationYield', 'decisionRegret', 'novelty', 'cost', 'rollbackIntegrity'];
  const known = experiment.trials.every(t => required.every(k => t.metrics[k] !== null && t.metrics[k] !== undefined && (typeof t.metrics[k] !== 'number' || Number.isFinite(t.metrics[k]))));
  if (!known) return { status: 'candidate', reason: 'unknown trial metrics block promotion' };
  const pass = experiment.trials.every(t => t.metrics.retrievalUtility >= 0.5 && t.metrics.verificationYield >= 0.5 && t.metrics.decisionRegret <= 0.25 && t.metrics.rollbackIntegrity === true);
  return { status: pass ? 'eligible' : 'rejected', reason: pass ? 'trials and holdout passed' : 'trial threshold failed', holdout };
}

function promoteExperiment(experiment, evaluation, input = {}) {
  if (!evaluation || evaluation.status !== 'eligible') return { status: 'candidate', reason: evaluation?.reason || 'experiment not eligible' };
  const policy = {
    policyId: requireText(input.policyId, 'policyId'), version: 1, parentHash: input.parentHash || null,
    lineage: [experiment.experimentHash], scope: requireText(input.scope, 'policy scope'),
    expiry: requireText(input.expiry, 'policy expiry'), rollbackTarget: input.parentHash || null,
    falsifiers: Array.isArray(input.falsifiers) && input.falsifiers.length ? input.falsifiers : [requireText(input.falsifier, 'falsifier')],
    killCondition: requireText(input.killCondition, 'killCondition'), decision: requireText(input.decision, 'policy decision'),
  };
  policy.policyHash = hash(policy);
  return { status: 'promoted', policy, evaluation };
}

function revokePolicy(policyHash, reason, rollbackTarget, memDir) {
  if (!exactAnchor(policyHash)) throw new Error('policyHash must be exact');
  return appendRecord({ kind: 'policy', status: 'revoked', policyHash, reason: requireText(reason, 'revocation reason'), rollbackTarget: rollbackTarget || null }, memDir);
}

function quarantineRecords(memDir, predicate, reason) {
  const records = readRecords(memDir);
  const targets = records.filter(predicate);
  return targets.map(r => appendRecord({ kind: 'quarantine', status: 'quarantined', targetRecordHash: r.recordHash, reason }, memDir));
}

function measureDecision(packet, result = {}) {
  if (!packet || !packet.packetHash) throw new Error('a decision packet is required');
  const selected = Array.isArray(result.selectedEvidence) ? result.selectedEvidence : [];
  const used = Array.isArray(result.usedEvidence) ? result.usedEvidence : [];
  const relevant = Array.isArray(result.relevantEvidence) ? result.relevantEvidence : [];
  const verificationAttempts = Number(result.verificationAttempts || 0);
  const verificationPasses = Number(result.verificationPasses || 0);
  const predicted = Number(result.predicted);
  const actual = Number(result.actual);
  const novelty = Number(result.novelty || 0);
  const cost = Number(result.cost || 0);
  const rollback = result.rollback || {};
  if (![verificationAttempts, verificationPasses, predicted, actual, novelty, cost].every(Number.isFinite)) throw new Error('decision measurements must be finite');
  const utility = selected.length ? (used.filter(ref => relevant.includes(ref)).length / selected.length) : 0;
  const verificationYield = verificationAttempts ? verificationPasses / verificationAttempts : 0;
  const regret = Math.abs(actual - predicted);
  const rollbackIntegrity = rollback.beforeHash && rollback.afterHash && rollback.restoredHash
    ? rollback.beforeHash === rollback.restoredHash : false;
  return {
    retrievalUtility: utility,
    verificationYield,
    decisionRegret: regret,
    novelty,
    cost,
    rollbackIntegrity,
    packetHash: packet.packetHash,
  };
}

function promoteDecision(packet, measurements, thresholds = {}) {
  return {
    packetHash: packet.packetHash,
    status: 'candidate', reason: 'ordinary decision observations cannot promote policy', nextPolicy: null,
    rejectedPath: { packetHash: packet.packetHash, measurements },
  };
}

module.exports = { createDecisionPacket, measureDecision, promoteDecision, createExperiment, addTrial, evaluateExperiment, promoteExperiment, revokePolicy, quarantineRecords, textAnchor, exactAnchor, appendRecord, readRecords, loadPromotedPolicy };
