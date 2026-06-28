# MEMVECTOR — TF-IDF Recall Layer

> Branch `fleet/U-vector`, 2026-06-28.
> Implemented alongside this doc: `memvector.cjs`.

---

## Why This Exists

`memstore.recallFacts` scores facts by **raw token-count**: for each query token,
it adds 1 if that token appears as a substring in `topic + fact`. This is fast
and honest, but it has one structural blind spot:

> When a query mixes a **rare discriminative term** with a **common one**, every
> fact that matches *either* token receives the same integer score. The fact you
> actually want may not appear in the top-N slice.

Concrete example with 6 stored facts where "process" appears in 5 of them and
"subscription" in only 1 (the auth fact):

| Query | `recallFacts` result | `recall` result |
|---|---|---|
| `"subscription process"` | 6 facts tied at score=1; with `maxResults=5`, the **auth fact is silently dropped** | auth fact ranked **#1** with cosine ≈ 0.29; next fact ≈ 0.14 |

`memvector.recall` breaks this tie by weighting each term by how *rare* it is
across the corpus — inverse document frequency (IDF).

---

## How It Works

### Tokenisation

Same rules as `memstore.cjs`: lowercase, split on `/\W+/`, drop tokens shorter
than 3 characters. This keeps both modules' vocabularies identical.

### TF — Term Frequency

For a given document (or query):

```
tf(t, d) = count(t in d) / total_term_count(d)
```

Dividing by document length prevents longer facts from dominating solely because
they contain more words.

### IDF — Inverse Document Frequency (smooth variant)

Computed over the entire `facts.jsonl` corpus:

```
idf(t) = log( (1 + N) / (1 + df(t)) ) + 1
```

Where `N` is the total number of stored facts and `df(t)` is the number of facts
that contain term `t`. The `+1` offsets (scikit-learn convention) prevent
division-by-zero when `df = N` (term in every fact) and ensure universal terms
receive weight `1.0` rather than `0`, keeping cosine similarity well-defined.

Typical weight range in a 6-fact corpus:

| Term frequency | IDF value |
|---|---|
| 1 out of 6 docs (rare) | ≈ 2.25 |
| 3 out of 6 docs (half) | ≈ 1.55 |
| 5 out of 6 docs (common) | ≈ 1.15 |
| 6 out of 6 docs (universal) | 1.00 |

The ratio between a rare term and a near-universal one is roughly 2×, which is
enough to produce clearly separated cosine scores.

### TF-IDF Vectors

For each fact (and the query), multiply the TF and IDF weights element-wise to
produce a **sparse vector** (`Map<term, float>`). Only terms that appear in the
corpus receive an IDF value; query terms not in any fact are excluded
automatically.

### Cosine Similarity

```
cosine(q, d) = (q · d) / (‖q‖ · ‖d‖)
```

Returns a value in `[0, 1]`. The dot product is computed by iterating over the
*query* vector (typically small), which is faster than iterating every document
term when the corpus is large.

### Full Call Flow of `recall(query, opts)`

```
1. tokenize(query)                     → query_tokens[]
2. loadFacts(dir)                      → fact_entries[]
3. tokenize(topic + " " + fact)        → doc_tokens[] per fact
4. computeIDF(all doc token sets, N)   → idf Map<term, float>
5. computeTF(query_tokens) → toTFIDF  → query_vec
6. for each fact:
     computeTF(doc_tokens[i]) → toTFIDF → doc_vec
     score = cosine(query_vec, doc_vec)
7. filter score > minScore
8. sort descending, slice to maxResults
9. return [{fact: entry, score: float}]
```

IDF is recomputed on every call (no persistent state). At hundreds of facts
this runs in sub-millisecond; add an in-memory index if the corpus grows into
the thousands.

---

## Relationship to `memstore.recallFacts`

| Property | `recallFacts` | `recall` |
|---|---|---|
| Score type | Integer token count | Float cosine similarity [0, 1] |
| Term weighting | Uniform (+1 per match) | IDF-weighted (rare terms score higher) |
| Length normalisation | None (longer facts match more) | Yes (TF divides by token count) |
| Tie-breaking | Insertion order (stable sort) | Discriminative weight |
| Dependencies | None | None |
| Throws | No | No |
| Corpus required | No (scores each fact independently) | Yes (IDF needs the whole corpus) |

**`recallFacts` remains the right choice when:**
- The corpus is tiny (< ~10 facts) and IDF has no statistical basis.
- You need substring matching on partial tokens (e.g. "worktree" matching
  "worktrees") — both modules use the same tokeniser so this is a shared limit,
  but substring inclusion inside a token works differently in each.
- You want deterministic ordering for tied scores.

**`recall` is the better choice when:**
- The query mixes discriminative rare terms with common scaffolding words.
- You want a continuous ranked score for downstream weighting.
- The corpus has grown large enough that common terms saturate the integer count.

**`memcontext.cjs` wiring:** `buildContext` currently calls `recallFacts`. To
upgrade it to TF-IDF recall, replace the `ms.recallFacts(task, ...)` call with
`mv.recall(task, ...)` where `mv = require('./memvector.cjs')`. The return shape
differs: `recallFacts` returns `entry[]`; `recall` returns `[{fact, score}]`.
Callers should map `r.fact` to get the entry object.

---

## Honest Limits

| Limitation | Notes |
|---|---|
| **Requires token overlap** | There is no synonym expansion, stemming, or semantic embedding. "car" will not match "automobile"; "runs" will not match "running". Vector embeddings (e.g. a local sentence-transformers model or Anthropic's embedding API) would solve this, at the cost of an external dependency. |
| **IDF needs a corpus** | With fewer than ~5 facts, IDF weights carry little statistical meaning. `recallFacts` is equally good or better at that scale. |
| **Superseded facts returned** | Facts with a later `supersedes` pointer are ranked and returned like any other. Callers that need to exclude superseded entries should filter by `entry.id` against the `supersedes` chain. |
| **No persistence / caching** | IDF is recomputed on each `recall()` call. This is fine at hundreds of facts; add a startup-time index if the store grows large. |
| **`topic` field is part of the vector** | The search surface is `topic + " " + fact`, matching `recallFacts`. A short topic word like "auth" may appear in many query phrasings and add a small IDF-weighted boost. This is generally harmless and improves category-level matching. |

---

## Integration Example

```js
const { recall }    = require('./memvector.cjs');
const { appendFact } = require('./memstore.cjs');

// Seed a fact
appendFact({
  topic: 'auth',
  fact:  'Atlas authenticates via Claude Code subscription; no ANTHROPIC_API_KEY required.',
  source: 'session:abc',
  confidence: 'verified',
});

// Query with a paraphrased/mixed query
const results = recall('subscription credential billing', { maxResults: 3 });
// → [{ fact: { id: 'f-...', topic: 'auth', fact: '...', ... }, score: 0.42 }, ...]

for (const { fact, score } of results) {
  console.log(`[${score.toFixed(3)}] [${fact.confidence}] ${fact.fact}`);
}
```

---

## Future Work

- **Stemming**: reduce "processes", "processing", "processed" to a common root
  before TF counting. A Porter stemmer adds ~100 lines with no dependencies.
- **IDF caching**: build the IDF index once at process startup, invalidate on
  `appendFact`. Useful when `recall` is called in a tight dispatch loop.
- **Embedding recall**: upgrade the scoring function to use cosine over
  embedding vectors rather than TF-IDF vectors. Drop-in replacement for the
  `cosine()` step; the rest of the architecture stays identical.
- **Hybrid re-ranking**: run `recallFacts` as a fast pre-filter (first-pass
  candidate set), then re-rank with TF-IDF cosine for the final top-N.
