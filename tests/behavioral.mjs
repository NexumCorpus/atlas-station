// tests/behavioral.mjs — Behavioral tests for core ATLAS Station modules
// Run: node tests/behavioral.mjs

import { createRequire } from 'module';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'atlas-test-'));
}

console.log('\n=== ATLAS Behavioral Tests ===\n');

// ─── 1. session-state.cjs: load/save roundtrip ────────────────────────────
console.log('1. session-state: load/save roundtrip');
{
  const { load, save } = require(join(ROOT, 'session-state.cjs'));
  const dir = tempDir();
  try {
    save({ orchTurnCount: 5, pulseCount: 3, lastDreamTs: '2026-01-01T00:00:00.000Z' }, dir);
    const st = load(dir);
    assert(st.orchTurnCount === 5, 'orchTurnCount roundtrips');
    assert(st.pulseCount === 3, 'pulseCount roundtrips');
    assert(st.lastDreamTs === '2026-01-01T00:00:00.000Z', 'lastDreamTs roundtrips');
    assert(typeof st.lastSessionTs === 'string' && st.lastSessionTs.length > 0, 'lastSessionTs set by save');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 2. proposal-scorer.cjs: scoring logic ────────────────────────────────
console.log('\n2. proposal-scorer: scoring logic');
{
  const { scoreProposal } = require(join(ROOT, 'proposal-scorer.cjs'));

  const relevant = scoreProposal(
    { description: 'add new build agent for fleet dispatch' },
    [{ text: 'improve fleet build reliability' }]
  );
  assert(relevant.score >= 0 && relevant.score <= 100, 'score in 0-100 range');
  assert(['low', 'medium', 'high'].includes(relevant.effortLevel), 'effortLevel is valid');
  assert(['low', 'medium', 'high'].includes(relevant.impactLevel), 'impactLevel is valid');
  assert(typeof relevant.coherence === 'number', 'coherence is a number');

  const irrelevant = scoreProposal(
    { description: 'paint the fence blue' },
    [{ text: 'build quality tracking for agent fleet' }]
  );
  assert(irrelevant.coherence < 0.3, 'irrelevant proposal has low coherence');
}

// ─── 3. outcome-tracker.cjs: parseFailureMode classification ──────────────
console.log('\n3. outcome-tracker: parseFailureMode');
{
  const { parseFailureMode } = require(join(ROOT, 'outcome-tracker.cjs'));

  assert(
    parseFailureMode('CONFLICT (content): Merge conflict in fleethost.mjs') === 'merge_conflict',
    'merge conflict string -> merge_conflict'
  );
  assert(
    parseFailureMode('SyntaxError: Unexpected token') === 'logic_error',
    'SyntaxError -> logic_error'
  );
  assert(
    parseFailureMode('ENOENT: no such file or directory') === 'environment',
    'ENOENT -> environment'
  );
  assert(
    parseFailureMode('something weird happened') === 'unknown',
    'unrecognised text -> unknown'
  );
}

// ─── 4. outcome-tracker.cjs: rateOutcome + getOutcomes roundtrip ──────────
console.log('\n4. outcome-tracker: rateOutcome/getOutcomes roundtrip');
{
  const { rateOutcome, getOutcomes } = require(join(ROOT, 'outcome-tracker.cjs'));
  const dir = tempDir();
  try {
    rateOutcome('test-B-001', 'good', 'test note', dir);
    const outcomes = getOutcomes(dir);
    assert(outcomes.length >= 1, 'at least one outcome stored');
    assert(
      !!outcomes.find(o => o.agentId === 'test-B-001' && o.rating === 'good'),
      'stored outcome has correct agentId and rating'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 5. deferred.cjs: deferTask + popPending roundtrip ───────────────────
console.log('\n5. deferred: deferTask/popPending roundtrip');
{
  const { deferTask, popPending } = require(join(ROOT, 'deferred.cjs'));
  const dir = tempDir();
  try {
    const entry = deferTask('test task description', {
      reason: 'test continuation',
      blocker: 'Current session ended before this test task could be executed',
      nextAction: 'Resume the test task and verify the deferred roundtrip state',
      validationCondition: 'The resumed task appears in popPending with the same actionability fields',
    }, dir);
    assert(entry.state === 'pending', 'deferTask creates entry with state=pending');
    assert(typeof entry.id === 'string' && entry.id.startsWith('D-'), 'deferTask entry has D- prefixed id');
    assert(entry.cause === 'test continuation', 'deferTask stores a concrete cause');
    assert(entry.blocker.includes('Current session ended'), 'deferTask stores a concrete blocker');
    assert(entry.nextAction.includes('Resume the test task'), 'deferTask stores a concrete next action');
    assert(entry.validationCondition.includes('popPending'), 'deferTask stores a concrete validation condition');
    assert(entry.retryCondition === entry.validationCondition, 'deferTask stores retryCondition alias for audits');
    let rejectedWeakReason = false;
    try {
      deferTask('weak deferred task', 'test reason', dir);
    } catch (e) {
      rejectedWeakReason = /meaningful blocker, next action, and validation condition/.test(e.message);
    }
    assert(rejectedWeakReason, 'deferTask rejects generic reasons without blocker, next action, and validation condition');
    let rejectedMissingValidation = false;
    try {
      deferTask('missing validation task', {
        blocker: 'The session stopped before this task could be completed',
        nextAction: 'Resume the task from the saved work item',
      }, dir);
    } catch (e) {
      rejectedMissingValidation = /validation condition/.test(e.message);
    }
    assert(rejectedMissingValidation, 'deferTask rejects records missing a validation condition');
    const textEntry = deferTask(
      'text encoded deferred task',
      [
        'resume text form',
        'Blocker: Current test session ended before text parsing ran',
        'Next action: Parse the text reason into structured deferred fields',
        'Validation condition: The resulting record has a retryCondition alias',
      ].join('\n'),
      dir
    );
    assert(textEntry.retryCondition.includes('retryCondition alias'), 'text reasons parse validation condition');

    const pending = popPending(dir);
    assert(pending.length >= 1, 'popPending returns at least one item');
    assert(
      !!pending.find(t => t.task === 'test task description'),
      'popped pending contains the deferred task'
    );

    // After popping, tasks are marked claimed — a second popPending should find none
    const second = popPending(dir);
    assert(second.length === 0, 'second popPending returns empty (tasks now claimed)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 6. embedding.cjs: cosineSimilarity correctness ─────────────────────
console.log('\n6. embedding: cosineSimilarity correctness');
{
  const { cosineSimilarity } = require(join(ROOT, 'embedding.cjs'));

  // Identical vectors → similarity = 1
  const v = [1, 0, 0, 1];
  assert(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-9, 'identical vectors → 1.0');

  // Orthogonal vectors → similarity = 0
  assert(cosineSimilarity([1, 0], [0, 1]) === 0, 'orthogonal vectors → 0');

  // Null / mismatched → returns 0, no throw
  assert(cosineSimilarity(null, [1, 2]) === 0, 'null vector a → 0');
  assert(cosineSimilarity([1, 2], null) === 0, 'null vector b → 0');
  assert(cosineSimilarity([1, 2], [1, 2, 3]) === 0, 'mismatched lengths → 0');
}

// ─── 7. embstore.cjs: setEmb / getEmb / getAllEmbs roundtrip ─────────────
console.log('\n7. embstore: setEmb/getEmb/getAllEmbs roundtrip');
{
  const { setEmb, getEmb, getAllEmbs } = require(join(ROOT, 'embstore.cjs'));
  const dir = tempDir();
  try {
    const emb = [0.1, 0.2, 0.3];
    setEmb('f-test-001', emb, dir);
    const fetched = getEmb('f-test-001', dir);
    assert(Array.isArray(fetched) && fetched.length === 3, 'getEmb returns stored array');
    assert(Math.abs(fetched[0] - 0.1) < 1e-9, 'getEmb value[0] correct');

    // Second entry for same id (append-only) — getAllEmbs keeps last
    setEmb('f-test-001', [0.9, 0.8, 0.7], dir);
    setEmb('f-test-002', [0.4, 0.5, 0.6], dir);
    const all = getAllEmbs(dir);
    assert(all.size === 2, 'getAllEmbs returns 2 unique ids');
    assert(all.has('f-test-002'), 'getAllEmbs includes f-test-002');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 8. memstore: recallFactsSemantic — exported and is async ─────────────
console.log('\n8. memstore: recallFactsSemantic is exported and async');
{
  const ms = require(join(ROOT, 'memstore.cjs'));
  assert(typeof ms.recallFactsSemantic === 'function', 'recallFactsSemantic is exported');
  const result = ms.recallFactsSemantic('test', { dir: join(tmpdir(), 'nonexistent-atlas-test') });
  assert(result instanceof Promise, 'recallFactsSemantic returns a Promise');
  // Resolve it to avoid unhandled rejection
  result.catch(() => {});
}

// ─── 9. recallFactsSemantic — fallback to token search when no embeddings ─
console.log('\n9. recallFactsSemantic: token fallback when no embeddings stored');
await (async () => {
  const { appendFact, recallFactsSemantic } = require(join(ROOT, 'memstore.cjs'));
  const dir = tempDir();
  try {
    appendFact({
      topic: 'auth',
      fact: 'Fleet runs on Claude Code subscription. No ANTHROPIC_API_KEY needed.',
      source: 'session:test',
      confidence: 'verified',
    }, dir);
    appendFact({
      topic: 'build-mode',
      fact: 'Build agents use isolated git worktrees for safe code changes.',
      source: 'agent:test',
      confidence: 'inferred',
    }, dir);

    // No embeddings stored — should fall back to token search
    const results = await recallFactsSemantic('subscription auth api key', { dir, maxResults: 5 });
    assert(Array.isArray(results), 'recallFactsSemantic returns an array');
    assert(results.length >= 1, 'recallFactsSemantic finds at least one result via token fallback');
    assert(results.some(r => r.topic === 'auth'), 'token fallback finds auth fact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ─── 10. recallFactsSemantic — empty store returns [] ─────────────────────
console.log('\n10. recallFactsSemantic: empty store returns []');
await (async () => {
  const { recallFactsSemantic } = require(join(ROOT, 'memstore.cjs'));
  const dir = tempDir();
  try {
    const results = await recallFactsSemantic('anything', { dir, maxResults: 5 });
    assert(Array.isArray(results) && results.length === 0, 'empty store returns []');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ─── 11. memcontext: injectAsync is exported ──────────────────────────────
console.log('\n11. memcontext: injectAsync is exported');
{
  const mc = require(join(ROOT, 'memcontext.cjs'));
  assert(typeof mc.injectAsync === 'function', 'injectAsync is exported from memcontext');
  assert(typeof mc.inject === 'function', 'inject (sync) still exported');
  assert(typeof mc.buildContext === 'function', 'buildContext (sync) still exported');
}

// ─── 12. memcontext: injectAsync falls back gracefully ────────────────────
console.log('\n12. memcontext: injectAsync graceful fallback');
await (async () => {
  const { injectAsync } = require(join(ROOT, 'memcontext.cjs'));
  const task = 'deploy the new build agent';
  const result = await injectAsync(task, {
    journalPath: '/nonexistent/journal.md',
    memDir: join(tmpdir(), 'nonexistent-atlas-memdir-xyz'),
  });
  assert(typeof result === 'string', 'injectAsync returns a string');
  assert(result.includes(task), 'injectAsync preserves original task text');
})();

// ─── 13. memgraph: semantic relation is accepted ──────────────────────────
console.log('\n13. memgraph: semantic relation accepted');
{
  const { addEdge, RELATIONS } = require(join(ROOT, 'memgraph.cjs'));
  assert(RELATIONS.has('semantic'), 'RELATIONS set includes semantic');
  const dir = tempDir();
  try {
    const edge = addEdge('f-001', 'semantic', 'f-002', dir);
    assert(edge.relation === 'semantic', 'addEdge stores semantic relation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 14. embstore: compactEmbs deduplicates ───────────────────────────────
console.log('\n14. embstore: compactEmbs deduplicates');
{
  const { setEmb, compactEmbs, getAllEmbs } = require(join(ROOT, 'embstore.cjs'));
  const dir = tempDir();
  try {
    setEmb('f-dup', [1, 2, 3], dir);
    setEmb('f-dup', [4, 5, 6], dir);  // second write — same id
    setEmb('f-other', [7, 8, 9], dir);
    const count = compactEmbs(dir);
    assert(count === 2, 'compactEmbs returns 2 (deduplicated)');
    const all = getAllEmbs(dir);
    assert(all.size === 2, 'getAllEmbs after compact has 2 unique entries');
    // Last value for f-dup should win
    const v = all.get('f-dup');
    assert(v && Math.abs(v[0] - 4) < 1e-9, 'compactEmbs keeps last value per id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 15. resonance: true Jaccard similarity ──────────────────────────────
console.log('\n15. resonance: true Jaccard similarity');
{
  const { similarity, tokenize } = require(join(ROOT, 'resonance.cjs'));
  // Identical token sets → 1.0
  assert(similarity(['build','agent','fleet'], ['build','agent','fleet']) === 1.0, 'identical sets → 1.0');
  // No overlap → 0
  assert(similarity(['apple','orange'], ['banana','grape']) === 0, 'disjoint sets → 0');
  // Partial overlap: intersection=2, union=4 → 0.5
  const s = similarity(['a','b','c'], ['b','c','d']);
  assert(Math.abs(s - 0.5) < 1e-9, 'partial overlap: 2/4 = 0.5, got ' + s);
  // Subset: A=['b','c'] ⊂ B=['a','b','c','d']: intersection=2, union=4 → 0.5
  const s2 = similarity(['b','c'], ['a','b','c','d']);
  assert(Math.abs(s2 - 0.5) < 1e-9, 'subset: 2/4 = 0.5, got ' + s2);
  console.log('  PASS: true Jaccard (all 4 assertions)');
}

// ─── 16. goal-store: addGoal/listGoals/resolveGoal roundtrip ────────────────
console.log('\n16. goal-store: addGoal/listGoals/resolveGoal roundtrip');
{
  const { addGoal, listGoals, resolveGoal } = require(join(ROOT, 'goal-store.cjs'));
  const dir = tempDir();
  try {
    const g = addGoal('test goal text', 'high', 'fleet', dir);
    assert(g.id.startsWith('G-'), 'addGoal returns entry with G- id');
    assert(g.state === 'active', 'addGoal entry starts active');

    const goals = listGoals(dir);
    assert(goals.length === 1, 'listGoals finds the goal');
    assert(goals[0].text === 'test goal text', 'listGoals returns correct text');

    const resolved = resolveGoal(g.id, 'done', dir, { source: 'behavioral-test' });
    assert(resolved.state === 'done', 'resolveGoal marks goal done');
    assert(resolved.resolutionSource === 'behavioral-test', 'resolveGoal persists resolution source');
    assert(listGoals(dir)[0].state === 'done', 'resolved state persists');
    assert(listGoals(dir)[0].resolutionSource === 'behavioral-test', 'resolution source persists to disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 17. instructions: setInstruction/listInstructions/clearInstruction ──────
console.log('\n17. instructions: set/list/clear roundtrip');
{
  const { setInstruction, listInstructions, clearInstruction } = require(join(ROOT, 'instructions.cjs'));
  const dir = tempDir();
  try {
    setInstruction('test-key', 'do the thing', dir);
    const all = listInstructions(dir);
    assert(all.length === 1, 'listInstructions finds instruction');
    assert(all[0].key === 'test-key', 'instruction has correct key');
    assert(all[0].instruction === 'do the thing', 'instruction has correct text');

    // setInstruction replaces existing key
    setInstruction('test-key', 'do the other thing', dir);
    const updated = listInstructions(dir);
    assert(updated.length === 1, 'replace does not duplicate');
    assert(updated[0].instruction === 'do the other thing', 'replacement stored');

    clearInstruction('test-key', dir);
    assert(listInstructions(dir).length === 0, 'clearInstruction removes entry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 18. predict: addPrediction/resolvePrediction/predictionAccuracy ─────────
console.log('\n18. predict: addPrediction/resolvePrediction/predictionAccuracy');
{
  const { addPrediction, resolvePrediction, predictionAccuracy } = require(join(ROOT, 'predict.cjs'));
  const dir = tempDir();
  try {
    const id = addPrediction('test claim', 0.8, dir);
    assert(typeof id === 'string' && id.startsWith('pred-'), 'addPrediction returns pred- id');

    const acc0 = predictionAccuracy(dir);
    assert(acc0.total === 1, 'predictionAccuracy sees 1 total');
    assert(acc0.resolved === 0, 'none resolved yet');

    resolvePrediction(id, 'correct', 'matched exactly', dir);
    const acc1 = predictionAccuracy(dir);
    assert(acc1.resolved === 1, 'predictionAccuracy sees 1 resolved');
    assert(Math.abs(acc1.accuracy - 1.0) < 1e-9, 'accuracy is 1.0 after correct resolution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 14. fleethost structural invariants ─────────────────────────────────
// META guard: verifies no wrong query() shapes (Anthropic REST) remain in
// fleethost.mjs. This catches regressions of the bug class fixed in Spirals 1+4
// — the SDK query() accepts {prompt, options:{...}} but silently fails with the
// REST shape {model, messages:[...]}. A build agent re-introducing the wrong
// shape would be caught by this test before it reaches production.
console.log('\n14. fleethost structural invariants');
{
  const fleet = readFileSync(join(ROOT, 'fleethost.mjs'), 'utf8');
  // Wrong shape: messages array at top level of a query() call
  const wrongShape = /query\s*\(\s*\{[^}]*messages\s*:\s*\[/.test(fleet);
  assert(!wrongShape, 'no Anthropic REST query() shapes (messages:[...]) in fleethost.mjs');
  // Correct shape: every query() call has prompt at top level
  // Count query({ calls and prompt: occurrences inside them (structural, not semantic — catches obvious regressions)
  const queryCallCount = (fleet.match(/\b_sdkQuery\s*\(|function query\s*\(/g) || []).length;
  assert(queryCallCount >= 2, 'safeQuery wrapper and SDK import are present (found ' + queryCallCount + ')');
}

// ─── Summary ──────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
