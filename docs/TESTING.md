# Testing contract

The station has two acceptance surfaces:

## Deterministic gate

```text
npm run test:all
```

This runs the behavioral suite, provider/continuity checks, rating-boundary
checks, outcome-audit contract, static renderer contract, live Electron
renderer harness, and the extended fleet/wing/director/felt/grader/mission
suites.

The live renderer harness uses a deterministic preload bridge. It loads the
real `index.html` and exercises Enter, click-send, Shift+Enter, `@build`,
`@read`, agent cancellation, failure visibility, and composer cleanup without
starting the fleet or sending external work.

## Full local surface

```text
npm run test:full
```

This runs `test:all` and then the smoke suite. The smoke suite `require()`s every
root-level `.cjs` module (except the two Electron-process ones) and fails if any
of them throws; it needs no installed CLI.

### Full test surface

`npm test` is only the first step. `test:all` and `test:full` also need three
public sibling repositories at the commits CI pins, `pip install -e` for
Director2, and three environment variables. Without them five suites
(`test:causal-xenosoma`, `test:independent-receipts`, `test:wing:d2`,
`test:wing:felt`, `test:mission`) fail on missing paths; the three wing suites
now stop at once and say what is missing instead of waiting out a timeout.

```bash
# run from the atlas-station checkout; the siblings go in a folder beside it
SIB="$(cd .. && pwd)/atlas-siblings" && mkdir -p "$SIB"
git clone https://github.com/NexumCorpus/boundary "$SIB/boundary"
git -C "$SIB/boundary" checkout c2b925eec081b5b70affa3bbb19fb00cfd7dffb0
git clone https://github.com/NexumCorpus/recursive-discovery-engine "$SIB/recursive-discovery-engine"
git -C "$SIB/recursive-discovery-engine" checkout 8b317fd123d63d8349ec77a4f705eff3f226e3b2
git clone https://github.com/NexumCorpus/director2 "$SIB/director2-harness"
git -C "$SIB/director2-harness" checkout f5bd0cb8c474d4a7ade2a2f295f4520329cad892
python3 -m pip install -e "$SIB/director2-harness"   # inside a virtualenv on Debian/Ubuntu
export ATLAS_BOUNDARY_REPO="$SIB/boundary"
export ATLAS_RDE_REPO="$SIB/recursive-discovery-engine"
export D2_HARNESS="$SIB/director2-harness"
npm run test:full
```

In PowerShell, set the same three variables with `$env:NAME = 'path'`. These
pins match `.github/workflows/ci.yml`, which instead maps the folder to drive `E:`
on a Windows runner.

On Linux the two Electron suites (`test:renderer:live`, `test:renderer:visual`)
need a display (use `xvfb-run`) and a non-root user, because Electron refuses to
run as root without `--no-sandbox`. `test:fleet` prints `SKIP` and exits 0 when
no provider credentials are configured.

## Fleet lifecycle identity

The main-process lifecycle contract emits a monotonically increasing sidecar
generation with the child PID and start timestamp. Exit and spawn-failure
events carry that generation and an explicit `restarting` state; the renderer
surfaces these records so a stale sidecar cannot be mistaken for the current
one. `fleet-lifecycle-contract.mjs` checks the source contract, and the live
renderer harness verifies generation identity is visible in the thread.

## Goal-state persistence

Goal completion is a durable IPC operation, not a conversational acknowledgment.
The renderer sends `resolve-goal`; the Electron main process persists `done` or
`abandoned` through `goal-store.cjs`, and Station health treats both `done` and
legacy `completed` as terminal. Goal-resolution contracts and the isolated
goal-store persistence probe guard this distinction.

## Quality debt

```text
npm run audit:outcomes
npm run test:outcome-audit
```

The audit is read-only. `--strict` exits nonzero while any historical opaque
outcome is unresolved; on the author's live ledger that was A-132, A-133, and
A-134, and that failure is evidence of debt, not a reason to weaken the audit.
A fresh clone has no run records (`memory/runs.jsonl` is gitignored), so there
`audit:outcomes` reports `total: 0` and `--strict` exits 0. The figures in this
section describe the author's live ledger, not something a clone can reproduce.
The JSON report also emits a remediation queue for each opaque record; this
queue requires recovered run evidence or an explicit human disposition and
never authorizes rewriting history.

The outcome report also computes `goodRate`, `qualityTarget`, `targetMet`, and
`additionalGoodNeeded`. The target is strictly greater than 80%; when this was
written the author's live ledger stood at 14/18, so three additional evidenced
good outcomes were needed.

Proposal queue integrity

```text
npm run audit:proposals
npm run test:proposal-audit
```

The proposal audit requires that no HIGH proposal remains `pending`. It also
reports historical deferred HIGH records missing `nextAction` or
`retryCondition`; strict mode remains nonzero until those records are
reconciled with evidence. `test:proposal-audit` asserts that policy only against
a live ledger: it skips that check on CI and when `memory/proposals.ndjson` is
still byte-identical to the committed snapshot (the state of a fresh clone,
which carries one pending HIGH proposal). The hermetic fixtures run everywhere.

Autonomy continuation

The autonomy loop is time-bounded by the granted deadline, but it no longer
closes early after four idle turns. Idle turns back off; every fourth idle
turn forces a proposal/source/test discovery pass. Operator return or the
deadline remains the only normal stop condition.
Busy callbacks reschedule instead of silently dropping a tick, failed turns
record a bounded failure message and reschedule, and starting a new window
cancels any stale timer first.

Variant measurement provenance

`measure_variant.mjs` requires every run to provide non-empty `source` and
`runId` fields in the input JSON. This prevents archived or manually supplied
scores from being mistaken for independently reproduced observations; the
runner records the declared provenance and trace identifier alongside each
task score.

The CLI input therefore has this shape:

```json
{
  "source": "independent-live-run",
  "runId": "observer-visible-run-id",
  "measurements": [
    { "taskId": "task-001", "score": 0, "notes": "observable evidence" }
  ]
}
```

Memory continuity

`injectAsync()` preserves the same `{ context, stats }` shape as synchronous
`inject()` when semantic recall succeeds, so context-budget telemetry cannot
disappear on the richer memory path.

The continuity contract also normalizes non-string turn/crystal payloads,
creates missing memory directories, and treats zero-item reads as empty rather
than accidentally returning the entire rolling store.
Fresh epistemic graph writes create their directory before appending, so a
first relation cannot disappear through a best-effort caller.
Journal excerpts treat a zero limit as an intentional empty read, and session
narrative writes return the persisted entry so callers can distinguish success
from a swallowed filesystem failure.
Resonance reads clamp negative result limits to an empty result instead of
using JavaScript's negative-slice behavior to leak unintended matches.
