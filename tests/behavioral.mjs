// tests/behavioral.mjs — Behavioral tests for core ATLAS Station modules
// Run: node tests/behavioral.mjs

import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
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
    const entry = deferTask('test task description', 'test reason', dir);
    assert(entry.state === 'pending', 'deferTask creates entry with state=pending');
    assert(typeof entry.id === 'string' && entry.id.startsWith('D-'), 'deferTask entry has D- prefixed id');

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

// ─── Summary ──────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
