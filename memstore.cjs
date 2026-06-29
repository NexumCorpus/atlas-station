// ATLAS // station — structured memory store.
//
// Maintains two append-only JSONL files in `memory/` (beside this module by
// default, gitignored via the repo's `*.jsonl` rule):
//
//   facts.jsonl  — ground-truth fact entries, each with topic, confidence, source
//   runs.jsonl   — one entry per completed agent run (agentId, task, outcome)
//
// Design constraints:
//   • Append-only: entries are never overwritten. Superseding is via the
//     `supersedes` field on a new fact, not by modifying old ones.
//   • Non-fabrication: callers must provide an explicit `confidence` value.
//     The store accepts it but never upgrades or infers it.
//   • No external dependencies — plain Node.js fs only.
//
// Self-test: `node memstore.cjs`
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'memory');
const FACTS_FILE  = 'facts.jsonl';
const RUNS_FILE   = 'runs.jsonl';

// Module-level counter so two facts written at the same millisecond get
// distinct IDs within the same process lifetime.
let _factSeq = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure directory exists and append one JSON line to a file. */
function _appendLine(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj) + '\n', { flag: 'a', encoding: 'utf8' });
}

/**
 * Read all non-empty lines from a JSONL file.
 * Returns [] if the file does not exist.
 * Any other error (permissions, corrupt FS) is re-thrown.
 */
function _loadLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * appendFact(fact, dir?) — Record a ground-truth fact in the store.
 *
 * Required fields in `fact`:
 *   topic       {string}  Short category label. e.g. "auth", "build-mode".
 *   fact        {string}  The grounded statement. Be specific and verifiable.
 *   source      {string}  Origin. Convention: "agent:<id>", "session:<id>",
 *                         "human", "commit:<sha>".
 *   confidence  {string}  Must be one of: "verified" | "inferred" | "reconstructed"
 *                         — callers choose; the store never upgrades.
 *
 * Optional:
 *   supersedes  {string|null}  ID of an earlier fact this replaces.
 *
 * Returns the complete written entry (including generated `id` and `ts`).
 */
function appendFact(fact, dir = DEFAULT_DIR) {
  if (!fact || typeof fact !== 'object') throw new TypeError('appendFact: fact must be an object');
  const { topic, fact: text, source, confidence, supersedes = null } = fact;
  if (!topic)      throw new Error('appendFact: missing required field: topic');
  if (!text)       throw new Error('appendFact: missing required field: fact');
  if (!source)     throw new Error('appendFact: missing required field: source');
  if (!confidence) throw new Error('appendFact: missing required field: confidence');

  const VALID_CONF = new Set(['verified', 'inferred', 'reconstructed']);
  if (!VALID_CONF.has(confidence)) {
    throw new Error(`appendFact: confidence must be "verified", "inferred", or "reconstructed" (got "${confidence}")`);
  }

  const entry = {
    id:         `f-${Date.now()}-${++_factSeq}`,
    ts:         new Date().toISOString(),
    topic:      String(topic),
    fact:       String(text),
    source:     String(source),
    confidence: String(confidence),
    supersedes: supersedes ? String(supersedes) : null,
  };
  _appendLine(path.join(dir, FACTS_FILE), entry);

  // Async embedding generation — non-blocking, best-effort
  setImmediate(async () => {
    try {
      const { generateEmbedding, cosineSimilarity } = require('./embedding.cjs');
      const { setEmb, getAllEmbs } = require('./embstore.cjs');
      const emb = await generateEmbedding(`${entry.topic} ${entry.fact}`);
      if (!emb) return;
      setEmb(entry.id, emb, dir);
      // Semantic edge creation: check recent embeddings for cosine similarity > 0.75
      const allEmbs = getAllEmbs(dir);
      const recentIds = [];
      const lines2 = _loadLines(path.join(dir, FACTS_FILE)).slice(-21, -1);
      for (const ln of lines2) { try { const p = JSON.parse(ln); if (p.id) recentIds.push(p.id); } catch {} }
      const _memgraph = require('./memgraph.cjs');
      for (const prevId of recentIds) {
        const prevEmb = allEmbs.get(prevId);
        if (!prevEmb) continue;
        const sim = cosineSimilarity(emb, prevEmb);
        if (sim > 0.75) {
          try { _memgraph.addEdge(entry.id, 'semantic', prevId, dir); } catch {}
        }
      }
    } catch { /* non-fatal */ }
  });

  // Auto-relate: find overlapping recent facts and add graph edges
  try {
    const _memgraph = require('./memgraph.cjs');
    const _resonance = require('./resonance.cjs');
    const recentLines = _loadLines(path.join(dir, FACTS_FILE)).slice(-21, -1); // last 20 before this one
    const newTokens = _resonance.tokenize(entry.fact || '');
    if (newTokens.length > 0) {
      for (const line of recentLines) {
        let prev;
        try { prev = JSON.parse(line); } catch { continue; }
        if (!prev || !prev.id) continue;
        const prevTokens = _resonance.tokenize(prev.fact || '');
        const overlap = _resonance.similarity(newTokens, prevTokens);
        if (overlap > 0.3) {
          try { _memgraph.addEdge(entry.id, 'related_to', prev.id, dir); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal: graph is optional */ }

  return entry;
}

/**
 * appendRun(run, dir?) — Record a completed agent run.
 *
 * Required fields:
 *   agentId  {string}        e.g. "A-3"
 *   task     {string}        Original task text (before context injection).
 *   mode     {string}        "read" | "build"
 *   state    {string}        "done" | "failed"
 *
 * Optional:
 *   cost           {number|null}   USD cost (null if unknown).
 *   summary        {string}        Short outcome from agent.
 *   branch         {string|null}   Git branch (build mode only).
 *   transcriptPath {string|null}   Path to the .jsonl transcript (reserved).
 *
 * Returns the complete written entry.
 */
function appendRun(run, dir = DEFAULT_DIR) {
  if (!run || typeof run !== 'object') throw new TypeError('appendRun: run must be an object');
  const { agentId, task, mode, state, cost = null, summary = '', branch = null, transcriptPath = null } = run;
  if (!agentId) throw new Error('appendRun: missing required field: agentId');
  if (!task)    throw new Error('appendRun: missing required field: task');
  if (!mode)    throw new Error('appendRun: missing required field: mode');
  if (!state)   throw new Error('appendRun: missing required field: state');

  const entry = {
    ts:             new Date().toISOString(),
    agentId:        String(agentId),
    task:           String(task).slice(0, 500),
    mode:           String(mode),
    state:          String(state),
    cost:           (typeof cost === 'number') ? cost : null,
    summary:        String(summary).slice(0, 500),
    branch:         branch ? String(branch) : null,
    transcriptPath: transcriptPath ? String(transcriptPath) : null,
  };
  _appendLine(path.join(dir, RUNS_FILE), entry);
  return entry;
}

/**
 * recallFacts(query, opts?) — Keyword-based fact recall.
 *
 * Tokenizes `query` (lowercase, split on non-word chars, drops tokens < 3 chars),
 * scans all stored fact entries, scores each by the number of query tokens found
 * as substrings in `topic + fact` (lowercased), returns top `maxResults` sorted
 * by score descending.
 *
 * This is NOT semantic search. It only matches literal substrings. That is a
 * deliberate trade-off: simple, fast, honest about what it misses.
 *
 * Returns [] on empty query or no matches.
 */
function recallFacts(query, { dir = DEFAULT_DIR, maxResults = 5 } = {}) {
  const tokens = (query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (!tokens.length) return [];

  const lines = _loadLines(path.join(dir, FACTS_FILE));
  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .map(entry => {
      const haystack = `${entry.topic} ${entry.fact}`.toLowerCase();
      const score = tokens.filter(t => haystack.includes(t)).length;
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ entry }) => entry);
}

/**
 * recentRuns(n, dir?) — Return the last `n` run records, newest first.
 * Returns [] if no runs have been recorded yet.
 */
function recentRuns(n = 5, dir = DEFAULT_DIR) {
  const lines = _loadLines(path.join(dir, RUNS_FILE));
  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .slice(-Math.max(1, n))
    .reverse();
}

/**
 * lifetimeStats(dir?) — Aggregate totals across all stored runs.
 *
 * Returns:
 *   totalRuns  {number}  All recorded runs.
 *   buildRuns  {number}  Runs with mode === "build".
 *   doneRuns   {number}  Runs with state === "done".
 *   totalCost  {number}  Sum of all numeric cost fields (USD).
 */
function lifetimeStats(dir = DEFAULT_DIR) {
  try {
    const lines = _loadLines(path.join(dir, RUNS_FILE));
    const runs = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const totalCost = runs.reduce((s, r) => s + (typeof r.cost === 'number' ? r.cost : 0), 0);
    const totalRuns = runs.length;
    const buildRuns = runs.filter(r => r.mode === 'build').length;
    const doneRuns  = runs.filter(r => r.state === 'done').length;
    return { totalRuns, buildRuns, doneRuns, totalCost };
  } catch {
    return { totalRuns: 0, buildRuns: 0, doneRuns: 0, totalCost: 0 };
  }
}

function compactFacts(topic, dir) {
  dir = dir || path.join(__dirname, 'memory');
  try {
    const lines = fs.readFileSync(path.join(dir, FACTS_FILE), 'utf8').trim().split('\n').filter(Boolean);
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const matching = topic ? all.filter(f => (f.topic || '').toLowerCase().includes(topic.toLowerCase())) : all;
    return matching;
  } catch { return []; }
}

function factStats(dir) {
  dir = dir || path.join(__dirname, 'memory');
  try {
    const lines = fs.readFileSync(path.join(dir, FACTS_FILE), 'utf8').trim().split('\n').filter(Boolean);
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byTopic = {};
    all.forEach(f => { const t = f.topic || 'general'; byTopic[t] = (byTopic[t] || 0) + 1; });
    return { total: all.length, byTopic };
  } catch { return { total: 0, byTopic: {} }; }
}

/**
 * recallFactsSemantic(query, opts?) — Async semantic fact recall with token fallback.
 *
 * Generates a query embedding and scores all facts by cosine similarity (70%) +
 * token overlap (30%) when embeddings are available. Falls back to the sync
 * keyword-based recallFacts when the embedding model is unavailable.
 *
 * Returns [] on empty store; never throws.
 */
async function recallFactsSemantic(query, { dir = DEFAULT_DIR, maxResults = 5 } = {}) {
  // Load all facts
  const lines = _loadLines(path.join(dir, FACTS_FILE));
  const facts = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!facts.length) return [];

  // Try semantic scoring
  try {
    const { generateEmbedding, cosineSimilarity } = require('./embedding.cjs');
    const { getAllEmbs } = require('./embstore.cjs');
    const queryEmb = await generateEmbedding(query || '');
    if (queryEmb) {
      const allEmbs = getAllEmbs(dir);
      const tokens = (query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
      return facts
        .map(f => {
          const emb = allEmbs.get(f.id);
          const semanticScore = emb ? cosineSimilarity(queryEmb, emb) : 0;
          const haystack = `${f.topic} ${f.fact}`.toLowerCase();
          const tokenScore = tokens.length > 0
            ? tokens.filter(t => haystack.includes(t)).length / tokens.length
            : 0;
          // Blend: 70% semantic, 30% token when embedding available; token-only otherwise
          const score = emb ? (semanticScore * 0.7 + tokenScore * 0.3) : tokenScore * 0.3;
          return { f, score };
        })
        .filter(({ score }) => score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(({ f }) => f);
    }
  } catch { /* fall through to token search */ }

  // Fallback: existing token search
  return recallFacts(query, { dir, maxResults });
}

module.exports = { appendFact, appendRun, recallFacts, recallFactsSemantic, recentRuns, lifetimeStats, compactFacts, factStats };

// ---------------------------------------------------------------------------
// Self-test: `node memstore.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const os     = require('os');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-selftest-'));
  let ok = false;

  try {
    // ── appendFact ─────────────────────────────────────────────────────────
    const f1 = appendFact({
      topic: 'auth',
      fact:  'Fleet runs on Claude Code subscription. No ANTHROPIC_API_KEY needed.',
      source: 'session:5e708929',
      confidence: 'verified',
    }, testDir);
    assert.ok(f1.id.startsWith('f-'),       'fact ID should start with f-');
    assert.strictEqual(f1.confidence,        'verified');
    assert.strictEqual(f1.supersedes,        null);

    const f2 = appendFact({
      topic: 'build-mode',
      fact:  'Build agents use bypassPermissions in isolated git worktrees.',
      source: 'agent:V-build',
      confidence: 'verified',
    }, testDir);
    const f3 = appendFact({
      topic: 'build-mode',
      fact:  'node_modules are absent in worktrees — SDK deps cannot be installed there.',
      source: 'session:5e708929',
      confidence: 'verified',
      supersedes: f2.id,
    }, testDir);
    assert.strictEqual(f3.supersedes, f2.id, 'supersedes field should be stored');

    // ── validation ─────────────────────────────────────────────────────────
    assert.throws(
      () => appendFact({ topic: 'x', fact: 'y', source: 'z', confidence: 'made-up' }, testDir),
      /confidence must be/,
      'should reject unknown confidence values',
    );
    assert.throws(
      () => appendFact({ fact: 'y', source: 'z', confidence: 'verified' }, testDir),
      /missing required field: topic/,
    );

    // ── recallFacts ─────────────────────────────────────────────────────────
    const buildResults = recallFacts('build worktree bypass permissions', { dir: testDir, maxResults: 5 });
    assert.ok(buildResults.length >= 1,          'should recall at least one build-mode fact');
    assert.strictEqual(buildResults[0].topic,    'build-mode', 'top result should be build-mode');

    const authResults = recallFacts('subscription auth api key', { dir: testDir });
    assert.ok(authResults.some(r => r.topic === 'auth'), 'should recall auth fact');

    const none = recallFacts('', { dir: testDir });
    assert.deepStrictEqual(none, [], 'empty query returns empty array');

    const shortTokens = recallFacts('it is a', { dir: testDir });
    assert.deepStrictEqual(shortTokens, [], 'tokens <3 chars are ignored → no matches');

    // ── appendRun ─────────────────────────────────────────────────────────
    appendRun({ agentId: 'A-1', task: 'List files here.', mode: 'read', state: 'done', cost: 0.01, summary: 'Found 12 files.' }, testDir);
    appendRun({ agentId: 'A-2', task: 'Write tests for persist.cjs.', mode: 'build', state: 'done', cost: 0.23, summary: 'Tests pass.', branch: 'fleet/A-2' }, testDir);
    appendRun({ agentId: 'A-3', task: 'Fix the worktree bug.', mode: 'build', state: 'failed', summary: 'git error.' }, testDir);

    // ── recentRuns ─────────────────────────────────────────────────────────
    const runs = recentRuns(2, testDir);
    assert.strictEqual(runs.length,        2,     'recentRuns should return 2');
    assert.strictEqual(runs[0].agentId,    'A-3', 'most recent first');
    assert.strictEqual(runs[1].agentId,    'A-2');
    assert.strictEqual(runs[0].branch,     null,  'branch null when not set');
    assert.strictEqual(runs[1].branch,     'fleet/A-2');

    const allRuns = recentRuns(10, testDir);
    assert.strictEqual(allRuns.length, 3, 'recentRuns(10) returns all 3 when fewer exist');

    // ── missing dir → empty results (no crash) ─────────────────────────────
    const missingDir = path.join(testDir, 'does-not-exist');
    assert.deepStrictEqual(recallFacts('anything', { dir: missingDir }), []);
    assert.deepStrictEqual(recentRuns(5, missingDir), []);

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
