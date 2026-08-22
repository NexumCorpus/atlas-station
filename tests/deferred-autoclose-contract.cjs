'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deferred = require('../deferred.cjs');

const REASON = {
  blocker: 'Dream pulse produced a HIGH proposal outside an active build turn',
  nextAction: 'Open the proposal and verify the current source before changing it',
  validationCondition: 'A passing validation gate or an evidence-backed blocker ends the task',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-deferred-autoclose-'));
try {
  // 1. A solved crystallization-repair record exists in terminal state.
  const solved = {
    id: 'D-1000', ts: new Date(Date.now() - 3600e3).toISOString(),
    task: 'Diagnose and repair the repeated crystallization failure with error receipts.',
    reason: 'Auto-deferred from dream protocol (HIGH priority)', state: 'retired',
    fixCommits: ['92c2032'],
  };
  fs.appendFileSync(path.join(tmp, 'deferred.ndjson'), JSON.stringify(solved) + '\n', 'utf8');

  // 2. A re-seeded dream of the same defect is auto-closed, not queued.
  const reseed = deferred.deferTask('Diagnose the repeated crystallization failure again and repair it.', { ...REASON }, tmp);
  assert.equal(reseed.__autoClosed, true, 'crystallization re-seed must be auto-closed');
  assert.equal(reseed.duplicateOf, solved.id, 'auto-close must cite the solved record');
  assert.equal(deferred.listDeferred(tmp).filter(t => t.id === reseed.id).length, 0, 'auto-closed task must not enter deferred.ndjson');
  const audit = fs.readFileSync(path.join(tmp, 'deferred.ndjson.autoclose.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].closedId, reseed.id);
  assert.equal(audit[0].fixCommits[0], '92c2032');

  // 3. Unrelated tasks are never touched by the rule.
  const unrelated = deferred.deferTask('Wire real data into the hermes provenance block at terminalization.', { ...REASON }, tmp);
  assert.ok(!unrelated.__autoClosed, 'non-crystallization task must pass through');
  assert.equal(unrelated.state, 'pending');

  // 4. Crystallization-themed NEW work with no solved prior still queues normally.
  const fresh = deferred.deferTask('Instrument crystallization latency budgets for the renderer.', { ...REASON }, tmp);
  assert.ok(!fresh.__autoClosed, 'no solved prior means no auto-close');
  assert.equal(fresh.state, 'pending');

  console.log('deferred-autoclose contract: ALL PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}