// ATLAS // station — automatic fact extraction from agent reply text.
//
// Scans a text string (agent summary, task output, transcript excerpt) and
// extracts candidate facts for the memory store. Extracted facts:
//
//   • Are always stored with confidence:'inferred' — never upgraded.
//   • Are copied VERBATIM from the source text — never paraphrased or rewritten.
//   • Carry a caller-supplied `source` field for full traceability.
//
// Three entry points:
//
//   extractFacts(text, opts?)
//     Pure extraction. Returns candidate fact objects. Does NOT write to store.
//
//   deduplicateAgainstStore(candidates, dir?)
//     Filters a candidate list against facts already in the memstore.
//
//   extractAndStore(text, source, opts?)
//     Extracts, deduplicates, then writes survivors to the store. Returns
//     the written entries (same shape as appendFact return values).
//     Never throws — errors are swallowed and [] is returned.
//
// Integration point: call extractAndStore(run.summary, `agent:${run.agentId}:summary`)
// after each successful fleet run to grow the structured fact base automatically.
//
// Design gaps (honest):
//   - Keyword scoring misses paraphrases and domain synonyms.
//   - Sentence splitting fails on abbreviations containing periods (e.g. "v2.1.160.").
//   - Store dedup uses word-overlap heuristics; semantic duplicates with different
//     vocabulary are both stored — the `supersedes` field is the manual escape hatch.
//   - Topic detection is keyword-anchored and ATLAS-specific; it does not generalise.
//   - No transcript JSONL parsing — this module only processes plain text strings.
//     The agentlog JSONL path is reserved for a future dedicated extraction step.
//
// Self-test: `node fact-extractor.cjs`
'use strict';

const path = require('path');
const { appendFact, recallFacts } = require('./memstore.cjs');
const { textAnchor } = require('./circulation.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum segment character length to be considered as a fact candidate. */
const MIN_LEN = 30;

/** Maximum segment length — longer segments are prose, not discrete claims. */
const MAX_LEN = 320;

/** Minimum assertive-signal score to pass the extraction filter. */
const MIN_SCORE = 2;

/** Maximum facts written per extractAndStore call (guard against noise floods). */
const MAX_FACTS_DEFAULT = 10;

// ATLAS-specific topic keyword map.
// Ordered most-specific first — the first matching topic wins.
// Entries are [topicName, [keywords...]] where keywords are lowercased substrings.
const TOPIC_KEYWORDS = [
  ['auth',         ['api_key', 'anthropic_api_key', 'no api key', 'subscription login',
                    'subscription quota', 'credential', 'authenticate', 'api key']],
  ['architecture', ['electron', 'ptyhost', 'node-pty', 'xterm', 'preload.cjs',
                    'main.cjs', 'ipc channel', 'main process', 'browserwindow',
                    'webcontents', 'pty sidecar', 'conpty']],
  ['build-mode',   ['bypasspermission', 'build mode', 'build agent', 'isolated worktree',
                    'git worktree', 'fleet branch', 'approval round']],
  ['fleet',        ['fleethost', 'fleet sidecar', 'dispatch', 'agent run', 'agentid',
                    'read mode', 'canusertool', 'canusertool', 'sdk query']],
  ['memory',       ['memstore', 'atlas memory', 'appendfact', 'recallfacts',
                    'memcontext', 'fact-extractor', 'facts.jsonl', 'runs.jsonl',
                    'memory store', 'memory block', 'inject(']],
  ['testing',      ['self-test', 'assert.ok', 'assert.strict', 'tests pass', 'test pass',
                    'verify.mjs', 'test fails', 'all pass', 'node memstore']],
  ['install',      ['npm install', 'node_modules', 'prebuilt', 'rebuild native',
                    '@homebridge', '@anthropic-ai', 'getcommithash.bat']],
  ['git',          ['git commit', 'git push', 'git branch', 'git status', 'git diff',
                    'git worktree', 'commit sha', 'git log', 'git merge']],
];

// Verb / modal signals that indicate an assertive claim. Padded with spaces so
// they only match as words, not substrings of longer words.
const ASSERTIVE_SIGNALS = [
  ' is ',    ' are ',    ' uses ',  ' use ',    ' requires ', ' must ',
  ' cannot ', " can't ", ' runs ',  ' run on ', ' does ',    ' has ',
  ' have ',   ' provides ', ' enables ', ' returns ', ' stores ', ' writes ',
  ' reads ',  ' spawns ', ' bridges ', ' bundles ', ' authenticates ',
  ' draws ',  ' bypasses ', ' wraps ', ' exposes ', ' always ', ' never ',
  ' only ',   ' no longer ', ' is not ', ' are not ', ' does not ',
];

// Conversational / imperative starters that suggest a non-factual sentence.
const CONVERSATIONAL_RE = /^(I |We |Let |You |Please |Note |See |Check |Here |This |Just )/i;

// Leading bullet / symbol characters stripped from line beginnings.
const BULLET_RE = /^[\s•–—’✓✗✔►\-*#>]+/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * splitToSegments(text) — Split input text into candidate sentence segments.
 *
 * Handles:
 *   - Prose paragraphs (sentence-ending punctuation + whitespace)
 *   - Bullet/list lines (each newline-delimited line treated as its own segment)
 *
 * The lookbehind `(?<=[.!?])` preserves the terminating punctuation in the
 * preceding segment, giving us readable fact text that ends with a period.
 * Requires Node.js 10+ (V8 with ES2018 lookbehind — present in all Electron
 * versions used by this project).
 *
 * Returns raw string segments; callers apply length filtering.
 */
function splitToSegments(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(BULLET_RE, '').trim());
}

/**
 * detectTopic(text) — Map a text segment to the closest ATLAS topic tag.
 * Returns 'misc' when no keyword matches.
 */
function detectTopic(text) {
  const lower = text.toLowerCase();
  for (const [topic, keywords] of TOPIC_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return topic;
  }
  return 'misc';
}

/**
 * scoreSegment(segment) — Score a text segment's candidacy as an assertive fact.
 *
 * Higher = more likely to be a discrete, grounded claim.
 * The scoring is intentionally additive rather than threshold-per-feature so
 * partial signals accumulate rather than each being a hard gate.
 */
function scoreSegment(segment) {
  const padded = ` ${segment.toLowerCase()} `;
  let score = 0;

  for (const sig of ASSERTIVE_SIGNALS) {
    if (padded.includes(sig)) score += 1;
  }

  // Length bonuses — very short or very long segments are less useful
  if (segment.length > 40)  score += 1;
  if (segment.length > 80)  score += 1;
  if (segment.length > 200) score -= 1; // long → prose, not a claim

  // Penalise structural noise
  if (segment.endsWith('?')) score -= 4; // questions
  if (segment.endsWith(':')) score -= 2; // section headers
  if (CONVERSATIONAL_RE.test(segment)) score -= 1;

  return score;
}

/**
 * jaccardLong(a, b) — Jaccard similarity on "long" words (> 3 chars).
 *
 * Used for within-batch and against-store deduplication. Short words ("the",
 * "and", "has") are excluded so that structural filler doesn't inflate overlap.
 */
function jaccardLong(a, b) {
  const wordsOf = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (!wa.size && !wb.size) return 1; // both empty → identical
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * extractFacts(text, opts?) — Extract candidate facts from a text string.
 *
 * Pure function — does NOT write to the store. The caller decides whether to
 * persist, review, or discard the returned candidates.
 *
 * opts:
 *   source    {string}  Origin label for all extracted facts.
 *                       Convention: "agent:<id>:summary", "run:<ts>", "human".
 *                       Default: "extracted".
 *   minScore  {number}  Minimum assertive-signal score. Default: MIN_SCORE (2).
 *
 * Returns an array of candidate objects:
 *   { topic, fact, source, confidence: 'inferred' }
 *
 * `fact` is the verbatim segment from `text` — never paraphrased.
 * `confidence` is always 'inferred'. No exception. No upgrade path here.
 * Candidates are sorted by score descending; near-duplicates within the batch
 * are collapsed (Jaccard ≥ 0.70 on long words → only the higher-scored kept).
 */
function extractFacts(text, { source = 'extracted', minScore = MIN_SCORE } = {}) {
  if (!text || typeof text !== 'string') return [];

  const segments = splitToSegments(text).filter(
    s => s.length >= MIN_LEN && s.length <= MAX_LEN,
  );

  // Score, filter below threshold, sort best-first
  const scored = segments
    .map(s => ({ segment: s, score: scoreSegment(s) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score);

  // Deduplicate within batch — keep the higher-scored of any near-duplicate pair
  const accepted = [];
  for (const { segment } of scored) {
    const isDup = accepted.some(a => jaccardLong(segment, a.fact) >= 0.70);
    if (!isDup) {
      accepted.push({
        topic:      detectTopic(segment),
        fact:       segment,
        source:     String(source),
        confidence: 'inferred',
      });
    }
  }

  return accepted;
}

/**
 * deduplicateAgainstStore(candidates, dir?) — Filter out candidates that are
 * already substantially captured in the facts store.
 *
 * Algorithm:
 *   1. Build a keyword query from the longest words in each candidate.
 *   2. Use recallFacts to find up to 5 nearby stored facts.
 *   3. Compute Jaccard similarity between the candidate and each recalled fact.
 *   4. Suppress the candidate if Jaccard ≥ 0.60 vs any recalled fact.
 *
 * This is a best-effort filter. It can miss true duplicates if the stored
 * and candidate texts use sufficiently different vocabulary (recall is
 * keyword-based). Prefer `dedup: true` in `extractAndStore` — false positives
 * (keeping duplicates) are less harmful than false negatives would be here.
 *
 * dir: memstore directory. Default: <module-dir>/memory.
 */
function deduplicateAgainstStore(candidates, dir) {
  const memDir = dir || path.join(__dirname, 'memory');
  return candidates.filter(c => {
    // Build query from the candidate's longest words
    const words = c.fact.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    if (!words.length) return true; // can't check — keep

    const query = words.slice(0, 5).join(' ');
    let existing;
    try {
      existing = recallFacts(query, { dir: memDir, maxResults: 5 });
    } catch {
      // Recall failure → keep the candidate (false negative > crash)
      return true;
    }
    if (!existing.length) return true;

    const tooSimilar = existing.some(e => jaccardLong(c.fact, e.fact) >= 0.60);
    return !tooSimilar;
  });
}

/**
 * extractAndStore(text, source, opts?) — Extract facts from text, deduplicate
 * against the store, and write survivors. Main integration point.
 *
 * Typical call:
 *   extractAndStore(run.summary, `agent:${run.agentId}:summary`, { dir: memDir })
 *
 * opts:
 *   dir       {string}   memstore directory. Default: <module-dir>/memory.
 *   minScore  {number}   Extraction score threshold. Default: MIN_SCORE.
 *   dedup     {boolean}  Run store deduplication. Default: true.
 *   maxFacts  {number}   Max facts to write per call. Default: MAX_FACTS_DEFAULT.
 *
 * Returns the array of written fact entries (from appendFact), or [] on any error.
 * Never throws — extraction failure must never crash the fleet.
 */
function extractAndStore(text, source, {
  dir      = path.join(__dirname, 'memory'),
  minScore = MIN_SCORE,
  dedup    = true,
  maxFacts = MAX_FACTS_DEFAULT,
  hermes   = null,
} = {}) {
  try {
    let candidates = extractFacts(text, { source, minScore });
    if (dedup) {
      candidates = deduplicateAgainstStore(candidates, dir);
    }
    candidates = candidates.slice(0, maxFacts);

    const stored = [];
    for (const c of candidates) {
      // An extracted fact is a lossy derivative of this exact model-output
      // buffer. Preserve its anchor; never imply the model read the underlying
      // world completely or that its text is raw external source bytes.
      const packet = hermes ? {
        ...hermes,
        stage: 'memory-write',
        confidence: 'inferred',
        provenance: [...(hermes.provenance || []), {
          kind: 'model-output-utf8', ref: String(source), sha256: textAnchor(text),
        }],
        completeness: { scope: 'selected', read_bytes: Buffer.byteLength(text, 'utf8'), unread_bytes: 0, status: 'complete' },
        loss: { kind: 'derived', input_bytes: Buffer.byteLength(text, 'utf8'), output_bytes: Buffer.byteLength(c.fact, 'utf8'), status: 'unmeasured' },
        // Selection is explicit and independent of the source anchor. Pending
        // means the fact is retained as inferred, never silently upgraded.
        admission: { stale_status: 'fresh', falsifier_ref: 'holdout:independent-source', selector: 'independent-holdout' },
        falsifiers: [...(hermes.falsifiers || []), { ref: 'holdout:independent-source', status: 'pending', independent: true }],
      } : null;
      stored.push(appendFact({ ...c, hermes: packet }, dir));
    }
    return stored;
  } catch (err) {
    process.stderr.write(`[fact-extractor] extractAndStore error: ${err.message}\n`);
    return [];
  }
}

module.exports = {
  extractFacts,
  deduplicateAgainstStore,
  extractAndStore,
  detectTopic,
  splitToSegments,
};

// ---------------------------------------------------------------------------
// Self-test: `node fact-extractor.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const fs     = require('fs');
  const os     = require('os');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-extractor-selftest-'));
  let ok = false;

  // Representative agent summary text used across multiple test cases.
  // Mixes high-signal facts with low-signal noise (questions, short lines).
  const SAMPLE = [
    'The PTY sidecar runs under plain node.exe, not Electron.',
    'Build agents use bypassPermissions in isolated git worktrees.',
    'Authentication uses the local Claude Code subscription login.',
    'No ANTHROPIC_API_KEY is required for personal station use.',
    'The fleet sidecar dispatches one autonomous agent per task.',
    'xterm.js renders the PTY output in the Giger palette.',
    'What does this even do?',              // question — expect rejection
    'See above.',                            // too short — below MIN_LEN
    'Done.',                                 // too short
  ].join('\n');

  try {

    // ── 1. extractFacts returns structured candidates ────────────────────────
    const candidates = extractFacts(SAMPLE, { source: 'agent:T-1:summary' });

    assert.ok(Array.isArray(candidates),
      'extractFacts should return an array');
    assert.ok(candidates.length >= 3,
      `should extract at least 3 facts from SAMPLE (got ${candidates.length})`);

    // Structure checks
    assert.ok(candidates.every(c => c.confidence === 'inferred'),
      'all confidence values must be "inferred"');
    assert.ok(candidates.every(c => c.source === 'agent:T-1:summary'),
      'source label should propagate to all candidates');
    assert.ok(candidates.every(c => typeof c.topic === 'string' && c.topic.length > 0),
      'topic must be a non-empty string');
    assert.ok(candidates.every(c => typeof c.fact  === 'string' && c.fact.length >= MIN_LEN),
      'fact must be a string of at least MIN_LEN characters');

    // ── 2. Questions are rejected ────────────────────────────────────────────
    const hasQuestion = candidates.some(c => c.fact.includes('What does this even do'));
    assert.ok(!hasQuestion,
      'questions (ending with ?) should be rejected by the scorer');

    // ── 3. Short segments are excluded ──────────────────────────────────────
    const hasTooShort = candidates.some(c => c.fact.length < MIN_LEN);
    assert.ok(!hasTooShort,
      `no candidate should be shorter than MIN_LEN=${MIN_LEN} chars`);

    // ── 4. confidence is always 'inferred' — no escape path ─────────────────
    // Verify it comes back even after going through extractFacts with no opts.
    const defaultCandidates = extractFacts('The fleet runs on subscription. No API key needed.');
    assert.ok(defaultCandidates.every(c => c.confidence === 'inferred'),
      'confidence must be inferred even with default opts');

    // ── 5. detectTopic is accurate for ATLAS-specific keywords ──────────────
    assert.strictEqual(detectTopic('The fleet sidecar dispatches one agent per task.'),
      'fleet', 'fleet topic');
    assert.strictEqual(detectTopic('No ANTHROPIC_API_KEY is required for personal use.'),
      'auth', 'auth topic');
    assert.strictEqual(detectTopic('xterm.js renders the PTY output.'),
      'architecture', 'architecture topic (pty)');
    assert.strictEqual(detectTopic('Build agents use bypassPermissions in worktrees.'),
      'build-mode', 'build-mode topic');
    assert.strictEqual(detectTopic('npm install fails on this Windows platform.'),
      'install', 'install topic');
    assert.strictEqual(detectTopic('This is about cookies and baking.'),
      'misc', 'misc fallback when no keywords match');

    // ── 6. Within-batch dedup collapses near-identical sentences ─────────────
    const dupText = [
      'Build agents use bypassPermissions in isolated git worktrees.',
      'Build agents use bypassPermissions in isolated git worktrees, always.',
    ].join('\n');
    const dupResult = extractFacts(dupText, { source: 'test:dup' });
    assert.ok(dupResult.length <= 1,
      `near-duplicate sentences should collapse to 1 candidate (got ${dupResult.length})`);

    // ── 7. splitToSegments strips bullet symbols ─────────────────────────────
    const bullets = splitToSegments('• First item here.\n- Second item found.\n✓ Third done now.');
    assert.ok(bullets.some(s => s.startsWith('First')),
      'bullet (•) stripped from first segment');
    assert.ok(bullets.some(s => s.startsWith('Second')),
      'dash (-) stripped from second segment');
    assert.ok(bullets.some(s => s.startsWith('Third')),
      'check (✓) stripped from third segment');

    // ── 8. splitToSegments handles empty / null gracefully ──────────────────
    assert.deepStrictEqual(splitToSegments(''),   [], 'empty string → []');
    assert.deepStrictEqual(splitToSegments(null), [], 'null → []');

    // ── 9. extractAndStore writes to the store and returns entries ────────────
    const stored = extractAndStore(SAMPLE, 'agent:T-1:summary', {
      dir:   testDir,
      dedup: false, // no dedup so we get a clean count on first write
    });
    assert.ok(stored.length >= 1,
      `extractAndStore should write at least 1 fact (wrote ${stored.length})`);
    assert.ok(stored.every(e => typeof e.id === 'string' && e.id.startsWith('f-')),
      'stored entries must have valid fact IDs');
    assert.ok(stored.every(e => e.confidence === 'inferred'),
      'stored entries must carry confidence=inferred');
    assert.ok(stored.every(e => e.ts && e.ts.length > 0),
      'stored entries must have a timestamp');

    // A model-derived memory write must retain its exact response anchor and
    // the actual organism route rather than degrading into anonymous memory.
    const anchored = extractAndStore(SAMPLE, 'ATLAS:anchored', {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fact-extractor-anchor-')),
      dedup: false,
      hermes: {
        v: 1, flow_id: 'test-luna-flow', parent_flow_id: null,
        stage: 'memory-write', actor: 'ATLAS', organism: true,
        execution: { provider: 'codex-cli', model: 'gpt-5.6-luna', route: 'test' },
        provenance: [],
        completeness: { scope: 'unknown', read_bytes: 0, unread_bytes: 0, status: 'unknown' },
        authority: { level: 'derive', human_grant: null, mutation_allowed: false },
        loss: { kind: 'derived', input_bytes: 0, output_bytes: 0, status: 'unmeasured' },
        falsifiers: [],
      },
    });
    assert.ok(anchored.every(e => e.hermes.execution.model === 'gpt-5.6-luna'),
      'anchored facts retain executing Luna assignment');
    assert.ok(anchored.every(e => e.hermes.provenance.some(p => p.sha256 === textAnchor(SAMPLE))),
      'anchored facts retain exact response hash');
    assert.ok(anchored.every(e => e.hermes.provenance.some(p => p.kind === 'model-output-utf8') && e.hermes.completeness.scope === 'selected'),
      'derived response text cannot masquerade as complete raw source');

    // ── 10. Store dedup suppresses already-stored facts on second run ─────────
    const second = extractAndStore(SAMPLE, 'agent:T-1:summary', {
      dir:   testDir,
      dedup: true,
    });
    assert.ok(second.length < stored.length,
      `second run with dedup=true should write fewer facts (got ${second.length} vs ${stored.length} first time)`);

    // ── 11. extractAndStore never throws on bad input ────────────────────────
    const emptyResult = extractAndStore('', 'test:empty', { dir: testDir });
    assert.deepStrictEqual(emptyResult, [],
      'empty text → []');

    const nullResult = extractAndStore(null, 'test:null', { dir: testDir });
    assert.deepStrictEqual(nullResult, [],
      'null text → []');

    // ── 12. deduplicateAgainstStore filters near-duplicates from store ───────
    // Seed one known fact, then verify a near-duplicate is filtered.
    const { appendFact: af } = require('./memstore.cjs');
    af({
      topic:      'fleet',
      fact:       'The fleet sidecar dispatches one autonomous agent per task.',
      source:     'test:seed',
      confidence: 'verified',
    }, testDir);
    const nearDup = [{
      topic:      'fleet',
      fact:       'Fleet sidecar dispatches one autonomous agent per task.',
      source:     'test:candidate',
      confidence: 'inferred',
    }];
    const filtered = deduplicateAgainstStore(nearDup, testDir);
    assert.strictEqual(filtered.length, 0,
      'near-duplicate of a stored fact should be filtered by deduplicateAgainstStore');

    // A clearly different fact should pass through
    const different = [{
      topic:      'auth',
      fact:       'The ANTHROPIC_API_KEY is only needed for distribution to other users.',
      source:     'test:candidate',
      confidence: 'inferred',
    }];
    const kept = deduplicateAgainstStore(different, testDir);
    assert.strictEqual(kept.length, 1,
      'a clearly different fact should survive deduplicateAgainstStore');

    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
