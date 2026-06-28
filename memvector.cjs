// ATLAS // station — TF-IDF semantic recall over the memory fact store.
//
// Companion to memstore.cjs. Reads the same `memory/facts.jsonl` file and
// provides recall(query) → ranked [{fact, score}] using TF-IDF cosine
// similarity instead of raw substring-count scoring.
//
// Why this exists:
//   memstore.recallFacts counts how many query tokens appear as substrings
//   in each fact — every match contributes +1 regardless of how rare that
//   term is across the corpus. When a query mixes a rare discriminative term
//   with a common one, all matching facts tie at the same integer score and
//   the fact you actually want may not even appear in the top-N slice.
//
//   TF-IDF breaks this tie by weighting each term by its inverse document
//   frequency: terms that appear in fewer facts score higher. A query term
//   found in only 1 of 20 facts carries much more signal than one found in
//   18 of 20. Cosine similarity then measures the angular distance between
//   the (weighted) query vector and each (weighted) fact vector, returning a
//   continuous score in [0, 1] that ranks the corpus far more precisely than
//   an integer count.
//
// Design constraints (inherited from memstore.cjs):
//   • No external dependencies — pure Node.js built-ins.
//   • Read-only. This module never writes to the store.
//   • Never throws from recall() — on any error it returns [].
//   • Tokenisation matches memstore.cjs: lowercase, split on /\W+/,
//     drop tokens shorter than 3 characters.
//
// Self-test: `node memvector.cjs`
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'memory');

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * tokenize(text) → string[]
 *
 * Lowercase, split on non-word characters, drop tokens shorter than 3 chars.
 * Matches memstore.cjs's internal tokenisation so the same vocabulary is used
 * whether the caller is doing keyword recall or TF-IDF recall.
 *
 * Returns an array that MAY contain duplicates — duplicates are needed for
 * computing term frequency (count/total).
 */
function tokenize(text) {
  return (text || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
}

// ---------------------------------------------------------------------------
// TF-IDF core
// ---------------------------------------------------------------------------

/**
 * computeTF(tokens) → Map<term, float>
 *
 * Term frequency: count(term) / total_term_count_in_document.
 * Normalising by document length prevents longer facts from dominating
 * solely because they have more words.
 */
function computeTF(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const total = tokens.length || 1;
  const tf = new Map();
  for (const [term, count] of counts) tf.set(term, count / total);
  return tf;
}

/**
 * computeIDF(docTokenSets, N) → Map<term, float>
 *
 * Smooth IDF (scikit-learn convention):
 *   idf(t) = log( (1 + N) / (1 + df(t)) ) + 1
 *
 * Where N  = total number of documents (facts)
 *       df = number of documents that contain the term
 *
 * The +1 in the numerator and denominator prevents zero-division when every
 * document contains a term (df = N → log(1) + 1 = 1.0).  Universal terms
 * still carry weight 1.0 rather than 0, which keeps cosine math well-defined.
 * Rare terms (low df) receive significantly higher IDF values.
 *
 * docTokenSets: Array<Set<string>>  — one Set per document (unique terms only)
 * N:            number              — total document count
 */
function computeIDF(docTokenSets, N) {
  const df = new Map();
  for (const tokenSet of docTokenSets) {
    for (const term of tokenSet) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((1 + N) / (1 + freq)) + 1);
  }
  return idf;
}

/**
 * toTFIDF(tf, idf) → Map<term, float>
 *
 * Element-wise product of TF and IDF weights.
 * Only terms present in the corpus IDF map are included — query terms that
 * never appear in any stored fact contribute nothing to the similarity.
 */
function toTFIDF(tf, idf) {
  const vec = new Map();
  for (const [term, tfWeight] of tf) {
    const idfWeight = idf.get(term);
    if (idfWeight !== undefined) vec.set(term, tfWeight * idfWeight);
  }
  return vec;
}

/**
 * cosine(a, b) → float
 *
 * Cosine similarity between two sparse TF-IDF vectors.
 * Each vector is a Map<term, weight>.
 * Returns a value in [0, 1], or 0 if either vector is the zero vector.
 *
 * Iterates over `a` for the dot-product (the query vector is typically
 * smaller than a document vector, so this is the efficient direction).
 */
function cosine(a, b) {
  let dot   = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, weight] of a) {
    dot   += weight * (b.get(term) || 0);
    normA += weight * weight;
  }
  for (const [, weight] of b) {
    normB += weight * weight;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Fact loading
// ---------------------------------------------------------------------------

/**
 * loadFacts(dir) → entry[]
 *
 * Read all valid JSON lines from `<dir>/facts.jsonl`.
 * Returns [] if the file does not exist; re-throws on other fs errors.
 * Silently skips malformed lines.
 */
function loadFacts(dir) {
  const filePath = path.join(dir, 'facts.jsonl');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * recall(query, opts?) → [{fact, score}]
 *
 * Semantic recall over stored facts using TF-IDF cosine similarity.
 *
 * Algorithm:
 *   1. Tokenise query (same rules as memstore: lowercase, /\W+/ split, ≥3 chars).
 *   2. Load all facts from <dir>/facts.jsonl.
 *   3. For each fact, build a TF vector over `topic + " " + fact` text.
 *   4. Compute smooth IDF over the whole fact corpus.
 *   5. Build TF-IDF vectors for the query and each fact.
 *   6. Score each fact by cosine similarity against the query vector.
 *   7. Return top maxResults, sorted descending, with score ≥ minScore.
 *
 * Unlike memstore.recallFacts:
 *   • Rare query terms are weighted higher than common ones (IDF).
 *   • Ranking is by continuous cosine similarity [0, 1], not integer count.
 *   • Longer facts are not penalised or favoured — TF normalises by length.
 *   • Ties in the integer count that strand relevant facts outside top-N are
 *     broken by discriminative signal rather than insertion order.
 *
 * Honest limits:
 *   • Still requires TOKEN OVERLAP — the query and fact must share at least
 *     one token after tokenisation. There is no synonym expansion or semantic
 *     embedding. "car" will not match "automobile".
 *   • Superseded facts (facts with a later `supersedes` pointer) are returned
 *     like any other fact. Callers should filter by `entry.id` if they want
 *     to exclude superseded entries.
 *   • The IDF is computed fresh on every call (no caching). At hundreds of
 *     facts this is sub-millisecond; at tens of thousands add an index.
 *
 * opts:
 *   dir        {string}  memstore directory. Default: <module-dir>/memory.
 *   maxResults {number}  Maximum ranked results to return. Default: 5.
 *   minScore   {number}  Minimum cosine similarity to include (exclusive).
 *                        Default: 0 (include all overlapping facts).
 *
 * Returns [] on empty query, empty store, or no matches above minScore.
 * Never throws — on any error returns [].
 */
function recall(query, { dir = DEFAULT_DIR, maxResults = 5, minScore = 0 } = {}) {
  try {
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    const facts = loadFacts(dir);
    if (!facts.length) return [];

    // Build a token array for each fact.
    // Use "topic + fact" as the search surface — same as memstore.recallFacts.
    const docTokenArrays = facts.map(entry =>
      tokenize(`${entry.topic} ${entry.fact}`)
    );

    // Compute IDF over the full corpus.
    const docTokenSets = docTokenArrays.map(arr => new Set(arr));
    const N            = facts.length;
    const idf          = computeIDF(docTokenSets, N);

    // Build the query TF-IDF vector.
    // Terms that never appear in the corpus have no IDF entry → excluded by toTFIDF.
    const queryTF  = computeTF(queryTokens);
    const queryVec = toTFIDF(queryTF, idf);

    // If no query terms overlap with the corpus vocabulary, no matches.
    if (!queryVec.size) return [];

    // Score each fact and collect results.
    const scored = facts.map((entry, i) => {
      const docTF  = computeTF(docTokenArrays[i]);
      const docVec = toTFIDF(docTF, idf);
      const score  = cosine(queryVec, docVec);
      return { fact: entry, score };
    });

    return scored
      .filter(r => r.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

module.exports = { recall, tokenize, computeTF, computeIDF, toTFIDF, cosine };

// ---------------------------------------------------------------------------
// Self-test: `node memvector.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert  = require('assert');
  const os      = require('os');
  const { appendFact, recallFacts } = require('./memstore.cjs');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memvector-selftest-'));
  let ok = false;

  try {
    // ── Seed the corpus ──────────────────────────────────────────────────────
    //
    // Design: the word "process" appears in 5 of 6 facts (high df → low IDF).
    //         the word "subscription" appears in 1 of 6 (low df → high IDF).
    //
    // The IDF contrast is:
    //   IDF("process")      = log(7/6) + 1 ≈ 1.15   (near-ubiquitous)
    //   IDF("subscription") = log(7/2) + 1 ≈ 2.25   (rare, discriminative)
    //
    // Query "subscription process":
    //   memstore.recallFacts: all 6 facts match exactly 1 query token each →
    //     tied at score = 1. With default maxResults = 5, the auth fact
    //     (written last, ranked last in a stable sort) IS DROPPED.
    //   recall (TF-IDF): the auth fact's "subscription" token receives ~2×
    //     the weight of any "process" token → auth fact is ranked first.

    const src = 'session:selftest';
    const conf = 'verified';

    appendFact({ topic: 'build',  fact: 'Build agents operate in isolated git worktrees; each agent is a separate node process.',           source: src, confidence: conf }, testDir);
    appendFact({ topic: 'arch',   fact: 'The Electron main process spawns ptyhost.cjs as a child process via stdio IPC.',                   source: src, confidence: conf }, testDir);
    appendFact({ topic: 'fleet',  fact: 'Fleet coordinator manages the lifecycle of each agent process and monitors run state.',             source: src, confidence: conf }, testDir);
    appendFact({ topic: 'pty',    fact: 'ptyhost.cjs uses node-pty to host the claude process inside a pseudo-terminal emulator.',          source: src, confidence: conf }, testDir);
    appendFact({ topic: 'signal', fact: 'The abort controller terminates the agent process when the user requests cancellation.',           source: src, confidence: conf }, testDir);
    // ↑ facts 0-4: all contain "process"; none contain "subscription"
    appendFact({ topic: 'auth',   fact: 'Atlas authenticates via Claude Code subscription; no ANTHROPIC_API_KEY credential is required.',   source: src, confidence: conf }, testDir);
    // ↑ fact 5 (auth): contains "subscription" and "credential"; does NOT contain "process"

    // ── Unit tests for core math ─────────────────────────────────────────────

    // tokenize
    assert.deepStrictEqual(
      tokenize('Hello, World! It is a test.'),
      ['hello', 'world', 'test'],
      'tokenize: drops short tokens, lowercases, splits on non-word chars',
    );
    assert.deepStrictEqual(tokenize(''), [], 'tokenize: empty string → []');
    assert.deepStrictEqual(tokenize(null), [], 'tokenize: null → []');

    // computeTF
    const tf = computeTF(['apple', 'apple', 'banana']);
    assert.ok(Math.abs(tf.get('apple') - 2/3) < 1e-9, 'TF: apple = 2/3');
    assert.ok(Math.abs(tf.get('banana') - 1/3) < 1e-9, 'TF: banana = 1/3');

    // computeIDF — 3 docs, term in 1 doc vs term in 3 docs
    const sets = [new Set(['rare', 'common']), new Set(['common']), new Set(['common'])];
    const idf  = computeIDF(sets, 3);
    assert.ok(idf.get('rare') > idf.get('common'), 'IDF: rare term > common term');

    // cosine
    const a = new Map([['x', 1], ['y', 0]]);
    const b = new Map([['x', 1], ['y', 0]]);
    assert.ok(Math.abs(cosine(a, b) - 1.0) < 1e-9, 'cosine: identical vectors → 1.0');
    const c = new Map([['x', 0], ['y', 1]]);
    assert.ok(Math.abs(cosine(a, c) - 0.0) < 1e-9, 'cosine: orthogonal vectors → 0.0');
    assert.strictEqual(cosine(new Map(), new Map()), 0, 'cosine: zero vectors → 0');

    // ── recall: basic smoke test ─────────────────────────────────────────────
    const authResults = recall('subscription credential authentication', { dir: testDir });
    assert.ok(authResults.length >= 1, 'recall: should return at least one result');
    assert.strictEqual(authResults[0].fact.topic, 'auth',
      'recall: direct subscription query ranks auth fact first');
    assert.ok(authResults[0].score > 0 && authResults[0].score <= 1,
      'recall: score is in (0, 1]');

    const buildResults = recall('worktree isolated build agents', { dir: testDir });
    assert.strictEqual(buildResults[0].fact.topic, 'build',
      'recall: worktree query ranks build fact first');

    // ── THE KEY TEST: IDF breaks the tie that strands the auth fact ──────────
    //
    // memstore.recallFacts("subscription process", maxResults=5):
    //   All 6 facts score exactly 1 (each matches one query token).
    //   Stable sort preserves insertion order for ties.
    //   Facts 0-4 appear before fact 5 in the file → auth fact is position 6.
    //   Slice to 5 → auth fact IS SILENTLY DROPPED.
    //
    const msResults = recallFacts('subscription process', { dir: testDir, maxResults: 5 });
    assert.ok(
      !msResults.some(f => f.topic === 'auth'),
      'memstore.recallFacts: auth fact is absent from top-5 when tied at score=1 (IDF-naive baseline confirmed)',
    );

    // memvector.recall("subscription process", maxResults=5):
    //   IDF("subscription") >> IDF("process")
    //   Auth fact scores high; process facts score low.
    //   Auth fact is ranked #1.
    //
    const mvResults = recall('subscription process', { dir: testDir, maxResults: 5 });
    assert.ok(mvResults.length >= 1, 'recall: should return results for "subscription process"');
    assert.strictEqual(
      mvResults[0].fact.topic, 'auth',
      'recall: auth fact is ranked #1 — rare "subscription" term receives high IDF weight',
    );
    assert.ok(
      mvResults[0].score > mvResults[1].score,
      'recall: auth fact score is strictly higher than the next-ranked fact',
    );

    // Print the score spread to make the IDF effect visible
    console.log('\n  IDF-ranking demonstration for query "subscription process":');
    console.log('  memstore.recallFacts (integer count, auth fact absent from top-5):');
    msResults.slice(0, 3).forEach(f => console.log(`    [${f.topic}] …`));
    console.log('  memvector.recall (cosine similarity, auth fact ranked #1):');
    mvResults.slice(0, 3).forEach(r => {
      console.log(`    score=${r.score.toFixed(4)}  [${r.fact.topic}] ${r.fact.fact.slice(0, 60)}…`);
    });

    // ── edge cases ───────────────────────────────────────────────────────────
    assert.deepStrictEqual(recall('', { dir: testDir }), [],
      'recall: empty query → []');
    assert.deepStrictEqual(recall('it is', { dir: testDir }), [],
      'recall: all tokens < 3 chars → []');

    // Query with terms not in corpus → queryVec is empty → []
    assert.deepStrictEqual(recall('xyzzy frobnicate quux', { dir: testDir }), [],
      'recall: no corpus overlap → []');

    // Missing dir → []
    assert.deepStrictEqual(
      recall('anything', { dir: path.join(testDir, 'nonexistent') }),
      [],
      'recall: missing dir → [] without throwing',
    );

    // maxResults is respected
    const top2 = recall('process agent worktree', { dir: testDir, maxResults: 2 });
    assert.ok(top2.length <= 2, 'recall: maxResults respected');

    // minScore filters out weak matches
    const highBar = recall('process', { dir: testDir, minScore: 0.99 });
    assert.ok(highBar.every(r => r.score > 0.99), 'recall: minScore filtering works');

    ok = true;
  } catch (err) {
    console.error('\nFAIL:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log('\n' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
}
