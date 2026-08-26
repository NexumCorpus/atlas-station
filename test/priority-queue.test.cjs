'use strict';
const assert = require('assert');
const { classifyPriority, dreamMisdiagnosisGuard, sortQueue } = require('../priority-queue.cjs');

// 1. operator directive outranks dream idea
const op = classifyPriority({ source: 'operator', text: 'fix the thing' });
assert.strictEqual(op.rank, 1, 'operator should be rank 1');
const dream = classifyPriority({ source: 'dream', text: 'maybe improve memory' });
assert.strictEqual(dream.rank, 4, 'dream should be rank 4');

// 2. unverified defect falls to rank 4
const badDefect = classifyPriority({ source: 'self-assess', verified: true, priorArtChecked: true, defectStillExists: false });
assert.strictEqual(badDefect.rank, 4, 'defect missing evidence falls to rank 4');
assert.ok(/warning/i.test(badDefect.warning || ''), 'warning present');

const goodDefect = classifyPriority({ source: 'self-assess', verified: true, priorArtChecked: true, defectStillExists: true });
assert.strictEqual(goodDefect.rank, 2, 'verified defect is rank 2');

const scored = classifyPriority({ source: 'proposal', score: 55 });
assert.strictEqual(scored.rank, 3, 'scored proposal is rank 3');

// 3. misdiagnosis guard
const truncDream = { source: 'dream', text: 'The ## Build Brief was cut mid-sentence in the dispatch' };
assert.strictEqual(dreamMisdiagnosisGuard(truncDream), true, 'truncation dream rejected');
const opTrunc = { source: 'operator', text: 'Investigate whether dispatch truncates the brief; verify against memstore record cap.' };
assert.strictEqual(dreamMisdiagnosisGuard(opTrunc), false, 'operator directive mentioning truncation passes');
assert.strictEqual(dreamMisdiagnosisGuard({ source: 'dream', text: 'improve clustering' }), false, 'unrelated dream passes');

// 4. empty array safety
assert.deepStrictEqual(sortQueue([]), []);
assert.deepStrictEqual(sortQueue(null), []);

// ordering
const queue = sortQueue([
  { source: 'dream', ts: '2026-01-01T00:00:00Z' },
  { source: 'proposal', score: 30, ts: '2026-01-02T00:00:00Z' },
  { source: 'operator', ts: '2026-01-03T00:00:00Z' },
  { source: 'proposal', score: 80, ts: '2026-01-01T00:00:00Z' },
]);
assert.strictEqual(queue[0].source, 'operator');
assert.strictEqual(queue[1].score, 80);
assert.strictEqual(queue[2].score, 30);
assert.strictEqual(queue[3].source, 'dream');

console.log('all priority-queue tests passed');
