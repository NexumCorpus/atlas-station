'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deferred = require('../deferred.cjs');

const REASON = {
  blocker: 'The crystallization repair proposal re-seeded after its defect was fixed',
  nextAction: 'Verify current source before acting on the resumed task',
  validationCondition: 'A passing validation gate or an evidence-backed blocker ends the task',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-deferred-dedupe-'));
try {
  // 1. Identical task text inside the window is suppressed, with an audit trail.
  const first = deferred.deferTask('Diagnose the duplicated crystallization failure', { ...REASON }, tmp);
  assert.equal(first.state, 'pending');
  assert.ok(!first.__suppressed);

  const dupe = deferred.deferTask('Diagnose the DUPLICATED   crystallization\nfailure', { ...REASON }, tmp);
  assert.equal(dupe.__suppressed, true, 'whitespace/case-insensitive fingerprint must suppress');
  assert.equal(dupe.duplicateOf, first.id);
  const stored = deferred.listDeferred(tmp).filter(t => t.id === dupe.id);
  assert.equal(stored.length, 0, 'suppressed duplicate must not enter deferred.ndjson');

  const dedupes = fs.readFileSync(path.join(tmp, 'deferred.ndjson.dedupes.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(dedupes.length, 1);
  assert.equal(dedupes[0].duplicateOf, first.id);
  assert.equal(dedupes[0].suppressedId, dupe.id);

  // 2. A different task is still admitted.
  const other = deferred.deferTask('Post-restart verification of reasoning-stream activation', { ...REASON }, tmp);
  assert.ok(!other.__suppressed, 'distinct tasks must not be suppressed');

  // 3. A terminalized task never blocks fresh work on the same problem.
  const receipt = { eventId: 'event:dedupe', recordHash: 'sha256:ingress' };
  deferred.markQueued(first.id, receipt, tmp);
  deferred.markTerminal(first.id, { kind: 'ack', recordHash: 'sha256:term' }, tmp);
  const fresh = deferred.deferTask('diagnose the duplicated crystallization failure', { ...REASON }, tmp);
  assert.ok(!fresh.__suppressed, 'consumed task must not block a legitimate re-raise');

  // 4. findLiveDuplicate unit contract.
  const live = deferred.findLiveDuplicate(deferred.listDeferred(tmp), '  post-restart\tverification of reasoning-stream activation ');
  assert.equal(live.id, other.id);
  assert.equal(deferred.findLiveDuplicate(deferred.listDeferred(tmp), 'completely unrelated work'), null);

  // 5. Topic-cluster suppression: two REAL phrasings from the Aug-2026
  //    corpus that no exact/Jaccard rule could match.
  const para = deferred.deferTask(
    'Diagnose the repeated crystallization failure and seal continuity with a successful receipt before accepting another dream pulse as complete.',
    { ...REASON }, tmp); // fresh live task, long text
  assert.ok(!para.__suppressed);
  const paraDupe = deferred.deferTask(
    'Diagnose the duplicated crystallization failure and preserve failed sessions as retryable handoffs.',
    { ...REASON }, tmp);
  assert.equal(paraDupe.__suppressed, true, 'topical re-mint of a LIVE long task must suppress');

  // 6. Genuinely distinct work in a hot area stays admissible (real
  //    negative from the same corpus, measured 0/19 false positives).
  const distinctTask = deferred.deferTask('Recover the source intent for A-148 through A-151, then re-queue or explicitly close each item.', { ...REASON }, tmp);
  assert.ok(!distinctTask.__suppressed, 'distinct family must never be suppressed');

  // 7. Short texts are exempt from fuzzy matching.
  const s1 = deferred.deferTask('Audit A-999 ledger', { ...REASON }, tmp);
  const s2 = deferred.deferTask('Audit A-998 ledger', { ...REASON }, tmp);
  assert.ok(!s1.__suppressed && !s2.__suppressed, 'short similar tasks must both be admitted');
  console.log('deferred-dedupe-contract: ALL PASS');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
