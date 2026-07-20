'use strict';
const assert = require('assert');
const { createDecisionPacket, measureDecision, promoteDecision, createExperiment, addTrial, evaluateExperiment, promoteExperiment, textAnchor } = require('../decision-loop.cjs');

const base = {
  packetId: 'DL-1', decision: 'choose local retrieval policy',
  context: [{ ref: 'facts', anchor: textAnchor('facts') }, { ref: 'tests', anchor: textAnchor('tests') }],
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
assert.equal(promoteDecision(packet, measurements).status, 'candidate');
const rejected = promoteDecision(packet, { ...measurements, rollbackIntegrity: false });
assert.equal(rejected.status, 'candidate');
assert.ok(rejected.rejectedPath);

assert.throws(() => createExperiment({ experimentId: 'bad', name: 'bad', generator: 'same', grader: 'same', holdout: ['h'] }), /distinct/);
const experiment = createExperiment({ experimentId: 'exp-1', name: 'context-choice', generator: 'atlas-generator', grader: 'independent-grader', holdout: ['holdout-1'] });
assert.equal(evaluateExperiment(experiment, { passed: true, evidenceAnchor: textAnchor('holdout') }).status, 'candidate');
for (let i = 0; i < 3; i++) addTrial(experiment, { trialId: `t${i}`, evidenceAnchor: textAnchor(`trial-${i}`), graderReceipt: `grader-${i}`, metrics: { retrievalUtility: .8, verificationYield: .8, decisionRegret: .1, novelty: .2, cost: 1, rollbackIntegrity: true } });
const evaluation = evaluateExperiment(experiment, { passed: true, evidenceAnchor: textAnchor('holdout') });
assert.equal(evaluation.status, 'eligible');
const promoted = promoteExperiment(experiment, evaluation, { policyId: 'policy-1', scope: 'local-context', expiry: '2099-01-01', falsifier: 'holdout fails', killCondition: 'regression', decision: 'minimum-context' });
assert.equal(promoted.status, 'promoted');
assert.equal(promoted.policy.parentHash, null);
console.log('decision loop: ALL PASS');
