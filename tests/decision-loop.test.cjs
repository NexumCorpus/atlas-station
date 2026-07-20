'use strict';
const assert = require('assert');
const { createDecisionPacket, measureDecision, promoteDecision } = require('../decision-loop.cjs');

const base = {
  packetId: 'DL-1', decision: 'choose local retrieval policy',
  context: [{ ref: 'facts', anchor: 'sha256:facts' }, { ref: 'tests', anchor: 'sha256:tests' }],
  hypotheses: [
    { id: 'h1', claim: 'minimum sufficient context lowers cost', confidence: 0.7 },
    { id: 'h2', claim: 'full context improves verification yield', confidence: 0.3 },
  ],
  intervention: { name: 'bounded-context-ablation', reversible: true },
  authorized: true,
  prediction: { metric: 'verification-yield', target: 0.8, failureCondition: 'yield below 0.5' },
};

assert.throws(() => createDecisionPacket({ ...base, hypotheses: [base.hypotheses[0]] }), /two rival/);
assert.throws(() => createDecisionPacket({ ...base, intervention: { name: 'deploy', external: true } }), /external/);
assert.throws(() => createDecisionPacket({ ...base, authorized: false }), /explicit local authorization/);
assert.throws(() => createDecisionPacket({ ...base, intervention: { name: 'irreversible', reversible: false } }), /external or irreversible/);
const packet = createDecisionPacket(base);
assert.match(packet.packetHash, /^sha256:/);
const measurements = measureDecision(packet, {
  selectedEvidence: ['facts', 'tests'], usedEvidence: ['facts'], relevantEvidence: ['facts'],
  verificationAttempts: 4, verificationPasses: 3, predicted: 0.75, actual: 0.8,
  novelty: 0.4, cost: 12, rollback: { beforeHash: 'a', afterHash: 'b', restoredHash: 'a' },
});
assert.equal(measurements.retrievalUtility, 0.5);
assert.equal(measurements.verificationYield, 0.75);
assert.ok(Math.abs(measurements.decisionRegret - 0.05) < 1e-9);
assert.equal(measurements.rollbackIntegrity, true);
assert.equal(promoteDecision(packet, measurements).status, 'promoted');
const rejected = promoteDecision(packet, { ...measurements, rollbackIntegrity: false });
assert.equal(rejected.status, 'rejected');
assert.ok(rejected.rejectedPath);
console.log('decision loop: ALL PASS');
