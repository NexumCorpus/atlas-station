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

This runs `test:all` and then the PTY smoke suite. The smoke suite validates
that the local Claude sidecar seam is alive; it remains separate from the
deterministic gate because it depends on an installed local CLI.

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

The audit is read-only. `--strict` intentionally exits nonzero while the
historical opaque outcomes for A-132, A-133, and A-134 remain unresolved.
That failure is evidence of debt, not a reason to weaken the audit.
The JSON report also emits a remediation queue for each opaque record; this
queue requires recovered run evidence or an explicit human disposition and
never authorizes rewriting history.

The outcome report also computes `goodRate`, `qualityTarget`, `targetMet`, and
`additionalGoodNeeded`. The target is strictly greater than 80%; with the
current 14/18 historical rating, three additional evidenced good outcomes are
needed.

Proposal queue integrity

```text
npm run audit:proposals
npm run test:proposal-audit
```

The proposal audit requires that no HIGH proposal remains `pending`. It also
reports historical deferred HIGH records missing `nextAction` or
`retryCondition`; strict mode remains nonzero until those records are
reconciled with evidence.

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
