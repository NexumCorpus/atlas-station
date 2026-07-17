# ATLAS Station architecture

ATLAS Station is the Electron executive surface of Hermes. It is one local
organism with explicit seams, not a collection of separately personified
workers.

## Runtime spine

```text
Daniel
  -> Electron cockpit (index.html + preload.cjs)
  -> lifecycle owner (main.cjs)
  -> ATLAS / fleet sidecar (fleethost.mjs)
  -> provider adapter (providers/codex-cli.mjs)
  -> authenticated Codex CLI subscription
```

The ATLAS executive route resolves to `gpt-5.6-luna`. Build, read, research,
and memory tasks use purpose-specific Codex-family routes. The retained Claude
SDK is a compatibility provider and is not the identity or default execution
path.

## State and continuity

- `session-log.cjs` persists role-aware direct dialogue separately from
  autonomy and system turns.
- `memcontext.cjs` injects bounded direct dialogue, selected memories, current
  state, and evidence pointers.
- `crystals.cjs` stores compressed navigation units; crystals never replace
  source evidence.
- `continuity.cjs` compares current file pins with recoverable Reed-Solomon
  shard groups from Station.
- `main.cjs` assigns every sidecar a generation and converts live agents to
  `interrupted` if that generation exits, preventing stale work from appearing
  active after restart.

## Autonomous development

Autonomy is deadline-bounded. Idle turns back off rather than closing the
window, every fourth idle turn forces discovery, failures retain bounded
evidence and retry, busy ticks reschedule, and new windows cancel stale timers.

Every claimed improvement is admitted by `scripts/spiral-receipt.cjs`. A new
spiral requires a distinct subsystem/capability vector, changed measure,
evidence, falsifier, and kill condition. Continued work on an existing vector
is recorded as a continuation and cannot inflate the new-vector count.

## External organs and claims

- `wing-host.cjs` mounts language-independent external organs through JSONL
  events and an atomic file spool.
- `wings/director2/` provides discovery missions and persistent felt state.
- `grader.cjs` keeps claim generation separate from reproduction and holdout
  grading.
- `scripts/mission-run.mjs` executes the mission seam and preserves certified,
  rejected, and honest-null outcomes.

## Release truth

`v1.contract.json` is the machine-readable release boundary.
`scripts/v1-readiness.cjs` checks the required organs, provider assignment,
operator documentation, full acceptance suite, whole-organism rehearsal, and
clean worktree. The `v1.0.0` tag binds the verified release commit.
