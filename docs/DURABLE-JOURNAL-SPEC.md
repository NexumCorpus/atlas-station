# durable-journal

> Durable execution for a single Node process. SQLite WAL + idempotent step replay. No orchestrator required.

**Status: SPECIFICATION (pre-implementation).** This document is the README + API contract for the `durable-journal` npm library, derived from the `durable-journal-npm-design` fact in Hermes memory. Nothing here is shipped until the evidence gates in the Roadmap say so.

---

## Why

Durable-execution platforms (Temporal, Inngest, Restate) solve a real problem — workflows survive crashes and retries — but they charge you an orchestrator process, a network round trip per step, and an ops surface. Many workloads are *single-node*: one process, one machine, and the durability requirement is simply "if I crash mid-job, resume exactly where I left off, and never re-apply a side effect twice."

`durable-journal` is that case, reduced to an embeddable library:

- **One dependency**: better-sqlite3 (synchronous, transactional, fast).
- **Zero infrastructure**: the journal is a SQLite database file.
- **Crash recovery by replay**: on restart, committed steps are skipped; uncommitted ones re-execute.
- **Idempotency as a language feature**: `ctx.step(key, fn)` records `(key → result)` in the same transaction as the side-effect receipt.

## Install

```bash
npm install durable-journal
```

## Quick start

```js
import { openJournal } from "durable-journal";

const journal = await openJournal("./run.journal.db");

// A run is a named, resumable unit of work.
await journal.run("ingest-customer-42", async (ctx) => {
  const customer = await ctx.step("fetch", () =>
    fetchCustomer(42)
  );

  const invoice = await ctx.step("charge", async () => {
    const inv = await stripe.charge(customer);   // side effect
    return inv.id;                                // serializable result
  });

  await ctx.step("email", () => sendReceipt(invoice));
});

await journal.close();
```

If the process dies after `"charge"` commits but before `"email"`, the next boot replays: `fetch` and `charge` return their recorded results **without executing**, and only `email` runs. Each step's result is written to the journal before its function returns control to user code, so at-most-once semantics hold for any step whose side effect is itself transactional with the journal write (see [Durability model](#durability-model)).

---

## API

### `openJournal(path, options?) => Promise<Journal>`

Opens (creating if necessary) a journal database at `path`.

| Option | Type | Default | Description |
|---|---|---|---|
| `busyTimeoutMs` | number | 5000 | SQLite busy timeout |
| `checkpointInterval` | number | 1000 | WAL auto-checkpoint threshold |
| `onRecovery` | callback | — | Called per recovered run: `({ runId, replayedSteps })` |
| `readonly` | boolean | false | Open for inspection only |

Sets `journal_mode=WAL`, `synchronous=FULL` (configurable down to `NORMAL`; see trade-offs), and runs schema migration v1 idempotently.

### Journal

```ts
interface Journal {
  run(name: string, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  listRuns(filter?: RunFilter): RunRecord[];
  getRun(name: string): RunRecord | null;
  compact(before?: Date): void;      // delete terminal runs' step rows
  close(): Promise<void>;
}
```

#### `journal.run(name, fn)`

Executes or resumes a run identified by `name`. Behavior:

1. If a run record exists with status `completed`, returns its recorded result immediately (idempotent at run level).
2. If it exists with status `running`, enters **replay mode**: for each `ctx.step(key, …)` call, if the journal holds a committed result for `(runId, key)`, return it without invoking `fn`'s step body. Otherwise execute the step body and commit its result.
3. On first invocation, inserts a `running` run row, then executes.
4. If `fn` throws, the run is marked `failed` with the serialized error. Re-invoking `run(name, fn)` resumes from the last committed step.
5. Concurrent invocation of the same `name` within one process rejects with `RunLockedError`.

#### `Ctx`

```ts
interface Ctx {
  runId: string;
  attempt: number;
  step<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;          // journaled: survives restart
  log(level, msg, data?): void;              // appended to journal
}
```

- **`step(key, fn)`** — the core primitive. Keys must be deterministic and unique within the run; duplicate keys reject. `fn`'s return value must be JSON-serializable (structured-clone-safe) and ≤ `maxStepResultBytes` (default 2 MiB). The commit sequence inside SQLite is: BEGIN IMMEDIATE → INSERT/UPDATE step row `(key, status=committed, result, ts)` → COMMIT → resolve the promise. This ordering means a crash between the side effect and the commit causes a **re-execution** of `fn` (at-least-once); see Durability model.
- **`sleep(ms)`** — journaled wake-up time; on recovery the remaining duration is honored, not restarted.

### Schema (v1)

```sql
CREATE TABLE runs (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','failed','completed')),
  result BLOB,               -- final serialized result
  error BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE steps (
  run_name TEXT NOT NULL REFERENCES runs(name),
  seq INTEGER NOT NULL,       -- monotonic per-run ordinal
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','committed')),
  result BLOB,
  started_at INTEGER NOT NULL,
  committed_at INTEGER,
  PRIMARY KEY (run_name, key)
);
CREATE TABLE log (
  run_name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL,
  data BLOB,
  ts INTEGER NOT NULL
);
```

WAL mode keeps readers non-blocking during writes; `synchronous=FULL` ensures a committed step survives OS crash, not just process crash.

## Durability model

Honest about what an embedded journal can and cannot promise:

| Guarantee | Holds? | Notes |
|---|---|---|
| Process crash (kill -9) between steps | ✅ exact-once replay | Uncommitted steps re-run; committed steps skip |
| OS / power crash of committed steps | ✅ with `synchronous=FULL` | fsync-before-ack |
| Side effect fires but commit crashes | ⚠️ **at-least-once** | Inherent to any journaling system; mitigate by making `fn` itself idempotent or committing via a single external transaction |
| Multi-host concurrent writers | ❌ out of scope | Single-writer design; use SQLite's file locking to fail closed |

This is deliberately narrower than Temporal's exactly-once-with-activities story, priced accordingly.

---

## Benchmarks (plan)

All benchmarks run on identical hardware (single cloud VM, NVMe SSD, Node LTS), median of 7 runs, published with raw data and harness code so results are reproducible rather than asserted.

Workloads:

1. **W1 — step throughput**: 10k sequential steps, trivial bodies. Measures journal overhead per step (target: <0.5 ms/step with synchronous=NORMAL).
2. **W2 — fan-out**: 100 parallel runs × 100 steps each. Measures WAL contention behavior under a single writer pool.
3. **W3 — crash-recovery latency**: kill -9 at step N of 1000; measure time-to-resume and steps re-executed (target: re-executes exactly the uncommitted suffix).
4. **W4 — large-payload steps**: 1 MiB step results × 500 steps. Measures BLOB-write cost and compaction benefit.

Comparisons:

| Baseline | Comparison basis |
|---|---|
| **Temporal** (self-hosted, single-node docker-compose) | Equivalent workflow as Temporal Workflow + Activities; measures end-to-end step latency including server round trips |
| **Inngest** (cloud dev server) | Same workflow via Inngest functions + steps; includes network hop to dev server |
| **bare better-sqlite3** | Hand-rolled journal table, no library — our overhead floor |

Published metrics: p50/p95/p99 step latency, wall-clock per workload, bytes written, recovery time after W3 kill. Claimed wins must show ≥2× on W1/W2 against Temporal to appear in the README; otherwise we report parity honestly.

## Roadmap — E0→E3 evidence-gated spending ladder

Each epoch spends only what the previous epoch's evidence justifies. No gate, no spend.

| Epoch | Spend cap | Deliverable | Gate to advance |
|---|---|---|---|
| **E0** | Hours (one session) | This spec + skeleton repo with type definitions and failing tests encoding the API above | Spec reviewed; API survives a red-team read (no obvious deadlock/ambiguity) |
| **E1** | ~1 day | Working core: `openJournal`, `run`, `step`, crash-kill test passing on Linux; W1 benchmark harness | W3 kill-test demonstrates exact-suffix replay 20/20 kills; W1 under 1 ms/step |
| **E2** | ~1 week | Polish: `sleep`, `compact`, `onRecovery`, docs site, CI on 3 OSes; full benchmark suite incl. Temporal/Inngest baselines | Benchmark report shows a defensible niche (≥2× on W1/W2 or honest parity with 50× less infra); beta tag published |
| **E3** | Market-scale effort | Public 1.0: npm publish, README with real numbers, issue triage cadence | Sustained external adoption signal (downloads/issues from non-authors) before any further investment (plugins, clustering, encryption) |

Failure exits are first-class: if E1 cannot demonstrate correct crash recovery, or E2 shows no meaningful advantage over bare SQLite hand-rolling, the project is archived with an autopsy note rather than sunk-cost continued.

---

## Non-goals

- Distributed/multi-host execution (use Temporal).
- Exactly-once external side effects without cooperation from the side-effect target.
- Long-term archival storage of journals (compact() deletes; bring your own backup).

## License

MIT (planned).

---

*Provenance: drafted by A-275-R for ATLAS, derived from the `durable-journal-npm-design` memory fact. Source fact was not located verbatim in the live crystals manifest at draft time; this spec is reconstructed from the task directive (SQLite WAL, ctx.step idempotent replay, crash recovery, benchmark plan vs Temporal/Inngest, E0→E3 ladder) and should be diffed against the original fact when it resurfaces.*
