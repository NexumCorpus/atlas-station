# ATLAS Memory System — Design

> Branch `fleet/M-memory`, 2026-06-28.
> Implemented alongside this doc: `memstore.cjs`, `memcontext.cjs`, `fleethost.mjs` wiring.

---

## The Gap Today

The station has one continuity mechanism: a human-written markdown journal at
`~/.claude/projects/E--/memory/atlas-station.md`, plus a flat `MEMORY.md` index.
An agent only reads it if it explicitly opens the file; nothing forces or
auto-loads it. Nothing writes back what the fleet learned. Finished agent
transcripts (`.jsonl` via `agentlog.cjs`) sit unlinked from any durable record.
`fleet-state.json` (`persist.cjs`) captures live operational state (working /
done / failed / cost) but not outcomes or conclusions. The session ends and the
next dispatch starts cold.

Three gaps drive this design:

1. **Unreliable load** — memory is *available*, not *delivered*. An agent might
   skip it and start from scratch.
2. **No write-back** — the fleet's aggregate learning is never captured in
   structured form. Only the human journal holds it, maintained by hand.
3. **No relevance recall** — the journal is one prose blob. There is no way to
   ask "what do we know about worktrees?" without reading the whole thing.

---

## Goals

1. **Reliable load** — every dispatched agent receives a memory context block
   prepended to its task, drawn from the journal + recent structured facts. Memory
   is *delivered*, not hoped for.

2. **Structured write-back** — when an agent finishes, its run is recorded
   atomically in `runs.jsonl`. Fact entries can be appended programmatically via
   `appendFact()`. No auto-inferred facts; callers assert them explicitly.

3. **Keyword recall** — `recallFacts(query)` surfaces relevant facts by token
   overlap against the stored `topic + fact` text. Simple, fast, honest about
   what it does and doesn't find.

4. **Non-fabrication** — every stored fact carries `confidence` (verified /
   inferred / reconstructed) and `source`. The system never infers a fact or
   upgrades its confidence. Agents reading memory see labeled claims.

---

## What This Does NOT Solve

| Out of Scope | Rationale |
|---|---|
| Semantic / embedding recall | Requires external service or local model. Token overlap is sufficient at current scale; add embeddings if keyword recall proves insufficient. |
| Automatic pruning | Requires judgment about importance. Add `pruneOldFacts(before)` / `pruneOldRuns(before)` later when the stores grow. |
| Bidirectional journal update | The code never writes to `~/.claude/projects/E--/memory/`. Automated writes to a human-curated record would corrupt its signal. |
| Cross-machine sync | The structured store (`memory/`) is gitignored local runtime state. The `~/.claude` journal is the portable narrative substrate. |
| Agent transcript analysis | Extracting structured facts from JSONL transcripts requires a dedicated agent call per run. Deferred; `transcriptPath` field is reserved. |
| Semantic deduplication | Two facts with the same meaning but different words are both stored. Manual `supersedes` pointer is the escape hatch. |

---

## Architecture

```
~/.claude/projects/E--/memory/
  atlas-station.md        ← human narrative journal (READ only; never written by code)
  MEMORY.md               ← human index (not used by code)

E:\atlas-station\
  memstore.cjs            ← NEW: read/write the structured store
  memcontext.cjs          ← NEW: build + inject memory context for dispatch
  fleethost.mjs           ← MODIFIED: inject context on dispatch, record on completion

E:\atlas-station\memory\  ← NEW: runtime structured store (gitignored via *.jsonl rule)
  facts.jsonl             ← append-only fact entries
  runs.jsonl              ← append-only agent run records
```

The `memory/` directory is created on first write. The `*.jsonl` rule in
`.gitignore` already covers it — this store is runtime data, not source.

---

## Data Schemas

### Fact entry (`facts.jsonl`)

One JSON object per line.

```json
{
  "id": "f-1751078400000-1",
  "ts": "2026-06-28T00:00:00.000Z",
  "topic": "build-mode",
  "fact": "Build agents run in isolated git worktrees with bypassPermissions.",
  "source": "agent:V-build",
  "confidence": "verified",
  "supersedes": null
}
```

**`confidence` values:**

| Value | Meaning |
|---|---|
| `"verified"` | Confirmed by running code, inspecting output, or direct observation. |
| `"inferred"` | Deduced from context without direct verification. |
| `"reconstructed"` | Assembled from partial memory after the fact; treat as provisional. |

No other values are accepted. The caller must choose; the system does not upgrade.

### Run entry (`runs.jsonl`)

```json
{
  "ts": "2026-06-28T00:05:00.000Z",
  "agentId": "A-3",
  "task": "add error handling to persist.cjs",
  "mode": "build",
  "state": "done",
  "cost": 0.23,
  "summary": "Added try/catch around all file operations, self-test PASS.",
  "branch": "fleet/A-3",
  "transcriptPath": null
}
```

`task` is the ORIGINAL prompt (before context injection) so the record doesn't
embed its own memory block in a circular loop.

---

## Module Design

### `memstore.cjs` — structured store

Pure I/O module. No business logic beyond JSONL append and keyword recall.

```
appendFact(fact, dir?)    → entry    Write a fact. Requires: topic, fact, source, confidence.
appendRun(run, dir?)      → entry    Write a run record. Requires: agentId, task, mode, state.
recallFacts(query, opts?) → entry[]  Keyword-match facts, sorted by overlap score, newest-wins ties.
recentRuns(n, dir?)       → entry[]  Last n run entries, newest first.
```

**Append strategy:** `fs.writeFileSync` with `flag: 'a'`. Each write is one
complete JSON line — atomic at the OS level for the append case, no temp-file
rename needed. Directory created with `mkdirSync({ recursive: true })` on first
write.

**Recall algorithm:**

1. Tokenize `query`: lowercase, split on non-word chars, drop tokens shorter than 3 chars.
2. For each fact, count how many query tokens appear as substrings of `topic + fact` (lowercased).
3. Discard zero-score entries; sort descending by score; return top `maxResults`.

This is NOT semantic search. It only matches literal substrings. That is a
deliberate trade-off: simple, fast, and honest about what it misses.

### `memcontext.cjs` — context injection

Composes journal excerpt + recent runs + recalled facts into a labeled context
block for prepending to agent prompts.

```
buildContext(task, opts?) → string   Full context block, or "" if nothing loaded.
inject(task, opts?)       → string   Prepend context to task. Never throws.
```

`opts` defaults:

| Option | Default | Purpose |
|---|---|---|
| `journalPath` | `~/.claude/projects/E--/memory/atlas-station.md` | Which journal to read |
| `maxJournalChars` | `2000` | Truncation guard (journal may grow large) |
| `maxFacts` | `5` | Max recalled facts per dispatch |
| `maxRuns` | `5` | Max recent run entries per dispatch |
| `memDir` | `<module-dir>/memory` | Where memstore JSONL files live |

**`inject()` failure contract:** if `buildContext` returns `""`, throws, or the
journal is absent, the original task is returned unchanged. Memory failure must
never crash the fleet.

**Context block format (what agents receive):**

```
--- ATLAS MEMORY ---
[Station Journal — atlas-station.md | loaded 2026-06-28T02:17:00Z]
E:\atlas-station (git master @ d574922, NOT pushed). The realization of the
whole GUI arc: an Electron desktop app ... [... truncated]

[Recent Fleet Runs]
- A-3 (2026-06-28): build "add error handling to persist.cjs" → done ($0.23) [fleet/A-3]
- A-2 (2026-06-27): read "audit fleethost.mjs" → done ($0.09)

[Relevant Facts for: "fix the memory door in fleethost"]
- [verified] canUseTool must return updatedInput shape or SDK throws ZodError. (source: agent:32990eb)
- [verified] Build mode uses bypassPermissions + isolated worktrees. (source: agent:V-build)
--- END MEMORY ---

{original task}
```

The `--- ATLAS MEMORY ---` / `--- END MEMORY ---` delimiters give the agent a
clear boundary: what is memory, what is task.

### `fleethost.mjs` integration

Two additions, both wrapped in try/catch:

**On dispatch (before SDK `query()` call):**
```js
const mc = getMemcontext();
const enrichedTask = mc ? mc.inject(task) : task;
// ...
prompt: build ? (enrichedTask + BUILD_NOTE) : enrichedTask,
```

**On completion (in the `result` message handler):**
```js
const ms = getMemstore();
if (ms) try {
  ms.appendRun({ agentId: id, task, mode: build ? 'build' : 'read',
    state: done ? 'done' : 'failed', cost: m.total_cost_usd ?? null,
    summary: ..., branch: branch ?? null, transcriptPath: null });
} catch { /* never crash fleet */ }
```

`task` (the original, pre-enrichment prompt) is passed to `appendRun` to avoid
circular context storage.

---

## Non-Fabrication Discipline

The same discipline the journal describes for itself applies to this store:

1. **Explicit assertion only** — `appendFact()` requires the caller to specify
   `confidence`. The system never auto-classifies a fact's confidence level.
   If you can't name how you know it, don't write it yet.

2. **Source tracking** — every entry carries `source`. "Verified by whom?" is
   always answerable from the record. Format convention: `"agent:<id>"`,
   `"session:<id>"`, `"human"`, `"commit:<sha>"`.

3. **No interpolation in recall** — `recallFacts()` returns verbatim stored
   objects. It does not generate, paraphrase, or synthesize. The agent that
   reads these facts decides how to weigh them.

4. **Context block is visibly labeled** — the `--- ATLAS MEMORY ---` wrapper
   is hard-coded. An agent reading its own context can identify the boundary and
   hold memory facts at appropriate epistemic distance from the task.

5. **Reconstructed = provisional** — anything labeled `"reconstructed"` was
   assembled after the fact. It should be treated as a working hypothesis, not
   a ground truth.

---

## Trade-offs

| Concern | Trade-off Made |
|---|---|
| Keyword recall misses synonyms | Accept: simple + honest beats opaque magic. Embeddings are an additive upgrade when needed. |
| Context block adds tokens (~500-2000 chars) per dispatch | Accept: small relative to agent turn cost. Tune `maxJournalChars` / `maxFacts` if spend climbs. |
| Journal loaded synchronously on every dispatch | Accept: KB-sized file, sub-millisecond. Add caching if journal grows past ~100 KB. |
| `runs.jsonl` and `facts.jsonl` grow indefinitely | Accept: JSONL scan is fast at hundreds of entries. Add `pruneOld*()` when needed. |
| Memory modules loaded at fleethost startup | Mitigated: each load is wrapped in try/catch; failure = `null` module = passthrough. |
| Facts must be manually seeded | Accept: auto-extraction needs a dedicated agent. Seed script is trivial once the API exists. |
| Memory store is not synced across machines | Accept by design: `~/.claude` journal is the portable narrative; `memory/` is local runtime. |

---

## Seeding Initial Facts

The station already has several ground-truth facts worth seeding into `facts.jsonl`
on first startup. These come from verified sessions documented in the journal:

- Auth: fleet runs on Claude Code subscription, no API key needed (verified by `verify.mjs`)
- Safety: read-only gate blocks Write/Bash (verified by `verify3.mjs`)
- Build mode: worktrees on `fleet/<id>` branches with `bypassPermissions`
- Build gotcha: `node_modules` absent in worktrees — SDK agents can't install deps there
- Memory door fix: `canUseTool` must return `{ behavior, updatedInput }` or SDK throws ZodError

A `seed.cjs` script (future) would call `appendFact()` once for each of these.
On the first dispatch with the new system, the agent receives the journal which
contains these facts narratively — the structured store becomes more valuable
as runs accumulate.

---

## Honest Gaps (What I Know This Design Doesn't Cover)

- There is no feedback loop from agent output to facts. An agent might discover
  something new during a run (e.g., "found a bug in agentlog.cjs") but the run
  record only stores the outcome summary, not structured new facts. A future
  `appendFact` call from within a dispatched agent (via a special tool or result
  field) would close this loop.

- The context block is prepended verbatim. If the journal is verbose and
  `maxJournalChars` is generous, the agent's context window starts with a lot of
  potentially irrelevant background. The `maxJournalChars` default (2000 chars)
  is conservative; operators should tune it.

- `recallFacts` scans the entire `facts.jsonl` on every dispatch. At thousands
  of entries this becomes a noticeable overhead. An in-memory index (loaded once
  at startup, updated on `appendFact`) would fix this when it becomes a problem.

- The `supersedes` field on facts allows manual chaining ("this fact replaces
  that one") but `recallFacts` doesn't filter superseded entries out of results.
  A superseded fact is still returned. Add a `superseded_by` back-reference and
  filter in recall if this creates confusion.
