'use strict';

const crypto = require('crypto');

function clean(value) { return String(value == null ? '' : value).trim(); }

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
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
  if (context.some(item => !item || !item.anchor || !String(item.anchor).startsWith('sha256:'))) {
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
  const minUtility = Number.isFinite(thresholds.minUtility) ? thresholds.minUtility : 0.5;
  const minVerification = Number.isFinite(thresholds.minVerification) ? thresholds.minVerification : 0.5;
  const maxRegret = Number.isFinite(thresholds.maxRegret) ? thresholds.maxRegret : 0.25;
  const promote = measurements.retrievalUtility >= minUtility && measurements.verificationYield >= minVerification && measurements.decisionRegret <= maxRegret && measurements.rollbackIntegrity;
  return {
    packetHash: packet.packetHash,
    status: promote ? 'promoted' : 'rejected',
    reason: promote ? 'utility, verification, regret, and rollback thresholds passed' : 'one or more promotion thresholds failed',
    nextPolicy: promote ? { decision: packet.decision, intervention: packet.intervention.name, thresholds: { minUtility, minVerification, maxRegret } } : null,
    rejectedPath: promote ? null : { packetHash: packet.packetHash, measurements },
  };
}

module.exports = { createDecisionPacket, measureDecision, promoteDecision };
