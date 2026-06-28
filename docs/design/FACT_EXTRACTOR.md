# ATLAS Memory — Fact Extractor Design

> Module: `fact-extractor.cjs`
> Branch: `fleet/U-extract`, 2026-06-28.
> Closes the gap noted in MEMORY.md §"Honest Gaps": no feedback loop from
> agent output to structured facts.

---

## The Gap This Fills

`MEMORY.md` noted:

> *An agent might discover something new during a run (e.g., "found a bug in
> agentlog.cjs") but the run record only stores the outcome summary, not
> structured new facts.*

The `runs.jsonl` store captures `summary` as free text. That text contains
verifiable, reusable knowledge — yet it never enters `facts.jsonl`. Each new
dispatch starts without knowing what previous agents concluded.

`fact-extractor.cjs` closes that loop: after a fleet run completes, its
`summary` (or any agent reply text) is fed to `extractAndStore()`, which
pulls candidate facts out and appends them to the structured store with
`confidence:'inferred'`.

---

## Non-Fabrication Discipline

Three rules, hard-coded into the module:

1. **Verbatim only** — the `fact` field is the exact sentence from the source
   text, never paraphrased or rewritten. Any rewrite would be an assertion
   the module has no authority to make.

2. **`confidence:'inferred'` is always the ceiling** — the extractor cannot
   verify anything; it only reads text. `'inferred'` is the weakest accepted
   value and the only one this module ever emits.

3. **No auto-upgrade path** — `extractFacts` does not accept a `confidence`
   override. If a caller wants `'verified'`, they must call `appendFact`
   directly after independent verification.

These rules mean extracted facts are clearly marked as machine-guessed in
every context block an agent later reads.

---

## Algorithm

### 1. Segment extraction

Input text is split into candidate segments by:
- Sentence boundaries: lookbehind `(?<=[.!?])\s+` preserves the terminal
  punctuation in the preceding segment (the fact text ends with a period).
- Newlines: each line becomes a candidate (handles bullet lists).

Leading bullet symbols (`•`, `-`, `–`, `✓`, `►`, `#`, `>`) are stripped.
Segments shorter than 30 or longer than 320 characters are discarded.

### 2. Assertive-signal scoring

Each segment is scored by counting occurrences of verb/modal signals:
`is`, `are`, `uses`, `requires`, `must`, `cannot`, `runs`, `provides`,
`always`, `never`, etc. (padded with spaces to avoid substring collision).

Length bonuses (40+, 80+ chars) reward informative middle-length claims.
Penalties are applied for questions (`?` ending: −4), section headers (`:` ending: −2),
and conversational openers like `"I "`, `"Please "` (−1 each).

Segments scoring below `MIN_SCORE` (default: 2) are discarded.

### 3. Topic detection

A keyword map (ATLAS-specific, ordered most-specific first) assigns each
surviving segment to a topic tag:

| Topic | Example keywords |
|---|---|
| `auth` | `api key`, `subscription login`, `no api key` |
| `architecture` | `electron`, `ptyhost`, `xterm`, `main.cjs` |
| `build-mode` | `bypasspermission`, `isolated worktree`, `git worktree` |
| `fleet` | `fleethost`, `dispatch`, `agentid`, `read mode` |
| `memory` | `memstore`, `appendfact`, `facts.jsonl` |
| `testing` | `self-test`, `tests pass`, `verify.mjs` |
| `install` | `npm install`, `node_modules`, `@homebridge` |
| `git` | `git commit`, `git branch`, `git worktree` |
| `misc` | *(fallback)* |

### 4. Within-batch deduplication

After scoring, near-duplicate candidates within the same extraction batch are
collapsed. "Near-duplicate" = Jaccard similarity on long words (> 3 chars) ≥ 0.70.
The higher-scored of the pair survives. This prevents redundant variants of the
same sentence from flooding the store in a single call.

### 5. Store deduplication

`deduplicateAgainstStore()` queries `recallFacts` for up to 5 stored facts
sharing vocabulary with each candidate, then suppresses any candidate whose
Jaccard similarity to a recalled fact is ≥ 0.60 (looser threshold than
within-batch dedup, because `recallFacts` is itself lossy).

---

## Integration Point

Call after each successful fleet run in `fleethost.mjs`:

```js
const fe = getFactExtractor(); // lazy-load like memstore/memcontext
if (fe && m.summary) {
  fe.extractAndStore(m.summary, `agent:${id}:summary`, { dir: memDir });
}
```

`extractAndStore` never throws. Any extraction failure writes a message to
`stderr` and returns `[]`. The fleet is never blocked.

---

## Honest Gaps

| Gap | Why it exists | Mitigation |
|---|---|---|
| Keyword scoring misses paraphrases | No semantic model available in plain Node.js | Embeddings could replace keyword scoring; deferred until store proves insufficient |
| Abbreviations break sentence splitting | `"v2.1.160. Verified"` → one long segment | Accept: factual sentences rarely start with version numbers |
| Store dedup misses semantic duplicates | Jaccard only catches lexically similar texts | Manual `supersedes` field is the escape hatch; agents reading memory see both, which is safe |
| Topic `misc` is a catch-all | Keyword map covers only known ATLAS domains | Add entries as new domains emerge; `misc` facts are still stored and searched |
| No transcript JSONL parsing | Would require streaming a potentially large `.jsonl` per run | Reserved: `transcriptPath` field already exists; a future dedicated step can process it |
| Score thresholds are hardcoded | No tuning data yet | `minScore` is an explicit parameter; callers can lower it for longer, more verbose summaries |
| `extractFacts` is not idempotent on the store | Running twice on the same text writes twice (dedup only reduces, not eliminates) | `dedup: true` (default) suppresses most repeats; callers should gate on known-new summaries |
