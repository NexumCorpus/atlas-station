'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const loop = require('../decision-loop.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-decision-integration-'));
const context = 'source-backed context bytes';
const packet = loop.createDecisionPacket({
  packetId: 'integration-1',
  decision: 'select-minimum-sufficient-executive-context',
  context: [{ ref: 'source:context', anchor: loop.textAnchor(context) }],
  hypotheses: [
    { id: 'compact', claim: 'compact context is sufficient', confidence: 0.6 },
    { id: 'full', claim: 'full context is safer', confidence: 0.4 },
  ],
  intervention: { name: 'record-context-policy', reversible: true },
  prediction: { metric: 'successful executive turn', target: 1, failureCondition: 'failed result' },
  authorized: true,
});
loop.appendRecord({ kind: 'packet', status: 'pending', packet }, dir);
const measurements = loop.measureDecision(packet, {
  selectedEvidence: ['source:context'], usedEvidence: ['source:context'], relevantEvidence: ['source:context'],
  verificationAttempts: 1, verificationPasses: 1, predicted: 1, actual: 1, novelty: 0.8, cost: 1,
  rollback: { beforeHash: packet.packetHash, afterHash: packet.packetHash, restoredHash: packet.packetHash },
});
const outcome = loop.promoteDecision(packet, measurements);
loop.appendRecord({ kind: 'measurement', ...outcome, measurements }, dir);
assert.equal(outcome.status, 'promoted');
assert.equal(loop.readRecords(dir).length, 2);
assert.equal(loop.readRecords(dir)[0].recordHash.startsWith('sha256:'), true);

// A fresh process is the restart boundary: the promoted policy changes the next decision.
const child = spawnSync(process.execPath, ['-e', `
  const l=require(${JSON.stringify(path.join(__dirname, '..', 'decision-loop.cjs'))});
  const p=l.loadPromotedPolicy(${JSON.stringify(dir)});
  process.stdout.write(JSON.stringify({decision:p.decision, intervention:p.intervention}));
`], { encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr);
assert.deepEqual(JSON.parse(child.stdout), { decision: packet.decision, intervention: packet.intervention.name });

// Exact digest admission rejects synthetic sha256 prefixes.
assert.throws(() => loop.createDecisionPacket({ ...packet, packetId: 'bad', context: [{ ref: 'x', anchor: 'sha256:fake' }] }), /exact sha256/);
console.log('decision loop integration: ALL PASS');
