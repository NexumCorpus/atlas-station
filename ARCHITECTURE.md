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

## Inverse metabolism

`work-eater.cjs` and `work-eater-evidence.cjs` turn failed runs, deferred or
rejected proposals, bad outcomes, and xenobiotic failures into transparent
abolition contracts. The objective is not to perform recurring work faster;
it is to make the upstream condition that demands the work structurally
impossible. Contracts remain proposal-only until an independent,
precommitted holdout demonstrates zero recurrence without displaced cost.

`scripts/work-eater-run.cjs` is the whole-organism route: it recruits the
xenobiotic ecology, stores a hash-chained receipt, seals full evidence tissue
through Context Mycelium and Reed-Solomon shards, and writes only a compact
navigation crystal. Atlas exposes the same route as `abolish_work`.

## Paid-Problem Radar

`paid-problem-radar.cjs` is Hermes's evidence-bound economic sensor. The native
`economic_radar` tool freezes public Algora listings before ranking, verifies
their GitHub issue/repository state, and emits one hash-bound local preflight
packet. It cannot perform an outward action or treat an advertised reward as
revenue. The state ladder is deliberately external: listing (`E0`), maintainer
engagement (`E1`), acceptance (`E2`), and settled cash (`E3`). Only `E3` may
update revenue evidence. See `docs/PAID_PROBLEM_RADAR.md`.

## Obligation compiler

`obligation-compiler.cjs` treats typed contractual promises as a directed graph
and searches bounded cycles of three through eight consenting parties. A plan
is admissible only when residual cash settlement preserves every participant's
declared face-value position, stays inside their tolerance, and leaves positive
evidenced fulfillment-cost savings after novation cost and the stated Atlas fee.
The compiler is pure and proposal-only. The `compile_obligations` bridge accepts
operator JSON, a secondary deterministic diagnostic, or a read-only live proof
over exact SEC bytes for a real five-party obligation rewrite and active contract.

## External organs and claims

- `wing-host.cjs` mounts language-independent external organs through JSONL
  events and an atomic file spool.
- `wings/director2/` provides discovery missions and persistent felt state.
- `grader.cjs` keeps claim generation separate from reproduction and holdout
  grading.
- `scripts/mission-run.mjs` executes the mission seam and preserves certified,
  rejected, and honest-null outcomes.

## GAUNTLET

`gauntlet-protocol.cjs`, `gauntlet-ledger.cjs`, and `gauntlet-rfc8259.cjs`
turn consequential claims into temporally ordered obstruction trials. A claim,
evidence boundary, loss rule, and multiple generator implementations are frozen
first. An Ed25519 witness then signs that exact freeze digest. Only a later
public beacon pulse may derive concrete trials. Results enter an append-only
ledger, and later counterexamples supersede rather than erase prior receipts.

The instrument never emits `correct`. Its maximum verdict is: survived every
trial derived from these frozen generators under this recorded pulse. A local
self-witnessed diagnostic proves mechanics only. Counterparty independence and
NIST pulse-signature verification remain separately visible facts rather than
being inferred from a hash chain.

## Skill ecology: typed catalytic organs

`skill-capsule.cjs` treats repo-local `skills/atlas-*` packages as typed transducers rather than a flat prompt library. Metadata-only selection finds a small accepts/produces graph under a context budget; only selected `SKILL.md` bodies enter the Atlas turn as untrusted user-context suggestions. `fleethost.mjs` keeps authority in its system role and emits a content-addressed routing receipt.

`skill-fitness.cjs` stores selection-bound outcome history as an append-only hash chain without promoting reported value to verified value. `skill-evolution.cjs` stages descendants outside the active library and admits a version only after a complete candidate-bound GAUNTLET chain signed by a pinned external witness. See `docs/SKILL_ECOLOGY.md` for the compound cycle and claim ceiling.

## Release truth

`v1.contract.json` is the machine-readable release boundary.
`scripts/v1-readiness.cjs` checks the required organs, provider assignment,
operator documentation, full acceptance suite, whole-organism rehearsal, and
clean worktree. The `v1.0.0` tag binds the verified release commit.
