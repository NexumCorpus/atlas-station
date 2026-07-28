# Xenobiotic Ecology

## Purpose

The ecology makes recursive improvement falsifiable. Hermes remains the organism and
authority boundary; this module is one organ within it. Caste routes use the `codex-cli`
provider and assign OpenAI models by failure surface. The organ can recruit, measure,
quarantine, and propose. It cannot silently activate source changes or claim an
experiment succeeded without a receipt.

Atlas’s “alien architecture” vocabulary is executable here. It is not a second orchestrator and it does not grant itself authority. The ecology is a bounded control plane inside Hermes: it converts unresolved evidence into inspectable work, routes that work to differentiated castes, meters their metabolism, and preserves every birth, experiment, failure, death, and rollback in a hash-chained ledger.

## Flow

```text
contradiction / proposal
        │
        ▼
bounded morphogen gradient
        │
        ▼
caste recruitment ──► niche and population backpressure
        │
        ▼
model route + token/time/tool/mutation budget
        │
        ▼
precommitted independent holdout
        │
   ┌────┴────┐
   ▼         ▼
promote   apoptosis + rollback
   │         │
   └────┬────┘
        ▼
append-only spoor + live UI projection
```

## Caste contracts

| Caste | Failure surface | Default model | Mutation budget |
|---|---|---:|---:|
| Forager | Evidence acquisition | `gpt-5.5` | 0 |
| Pathogen | Falsification and poison detection | `gpt-5.6-terra` | 0 |
| Symbiont | Cross-organ synthesis | `gpt-5.6-luna` | 0 |
| Undertaker | Quarantine and rollback | `gpt-5.6-terra` | 1 |
| Cartographer | Lineage and dependency mapping | `gpt-5.5` | 0 |
| Instrument-builder | Measurement and holdout construction | `gpt-5.6-terra` | 1 |

Assignments are based on the cost of being wrong. A caste is a contract—purpose, permitted tools, route, budget, fallback—not a decorative agent name.

## Morphogen gradients

`gradientFromSignal` converts each contradiction, proposal, unknown, stale lineage, or
instrument gap into a deterministic bounded pressure. A gradient carries a niche,
magnitude in `[0, 1]`, confidence disagreement, staleness, impact, and evidence
references. `recruit` maps that pressure to complementary castes while enforcing
signal, niche, cycle, and population ceilings.

## Metabolism

Each recruited cell has hard token, wall-time, tool-call, and mutation budgets.
`metabolize` appends usage rather than mutating history. Crossing any limit records
apoptosis and removes the cell from active circulation. Snapshot projections expose
total and used metabolism without exposing authority material.

## Apoptosis

`apoptose` never deletes a failed lineage. It appends the cell ID, bounded reason, and
evidence references, then `projection` derives a quarantined state. Regression and
unrecoverable failure use this same path, leaving birth, experiment, failure, death,
and rollback spoor available for later audits.

## The Recombination Wall

`evaluateExperiment` accepts promotion only when a holdout was committed before the
trial, candidate and grader actors are independent, anchors form a valid content-hash
DAG, no falsifier fired, and the candidate beats the parent baseline. A rejected
candidate receives a `policy-revoked` record whose rollback target is the exact parent
policy hash.

## Autonomy

`ensureBootstrap` handles true emptiness by recruiting one instrument-builder whose
directive is to construct a falsifiable instrument. `autonomyTurn` selects the most
pressurized active cell while time remains. Operator return and deadline expiry are
absolute stops; no idle counter can reinterpret either boundary.

## Operator surface

`snapshot` emits a bounded projection for the live Ecology tab: caste/model counts,
gradients, niches, metabolism, lineage parentage, experiment verdicts and gains,
apoptosis reasons, rollback targets, sequence numbers, and record hashes. The UI is a
transparent view of spoor, not an alternate source of state.

## Security invariants

`append` rejects secret-bearing keys before serialization. `validateEvidenceAnchors`
rejects forged hashes, duplicate hashes, missing parents, and citation cycles.
Candidate/grader identity equality is treated as collusion. `verifyLedger` validates
sequence, previous-hash linkage, and every record hash before a projection is trusted.

## Failure semantics

`recordFailure` distinguishes recoverable organ loss from unrecoverable lineage loss.
A recoverable failure recruits the failed caste's declared fallback with
`parentCellId` and `lineageRoot` preserved. Unrecoverable failure is quarantined.
Population overflow produces idempotent backpressure; signal overflow fails closed.
No branch rewrites a prior record.

## Invariants

1. No evidence, no promotion. Candidate and grader must be different actors.
2. A holdout is committed before the experiment begins. Edited or circular evidence is rejected.
3. Recombination is the baseline. A candidate must beat it by the configured margin and trigger no falsifier.
4. Population, niche density, signals, projection size, text bytes, and per-cell metabolism are hard-bounded.
5. Exhaustion, regression, and unrecoverable failure cause apoptosis. Spoor is retained.
6. Failure recovery recruits a different fallback caste and preserves parent lineage.
7. Operator return and autonomy deadline are absolute stop conditions. Idle ecology causes discovery, not false completion.
8. Ledger records are hash-chained. Secret-bearing fields are rejected before persistence.
9. The UI receives a bounded projection: gradients, castes, niches, metabolism, lineage, experiments, and deaths.
10. This organ proposes and measures. Source activation still passes through the Hermes ingress, shadow-worktree, independent-receipt, and activation-manifest membranes.

## Interfaces

`xenobiotic-ecology.cjs` exports:

- `XenobioticEcology`: durable ledger, projection, recruitment, metabolism, recovery, experiments, autonomy selection, and UI snapshots.
- `gradientFromSignal`: contradiction/proposal → bounded morphogen gradient.
- `routeCaste`: exact caste/model/tool/budget contract.
- `validateEvidenceAnchors`: forged-anchor, duplicate, and citation-cycle defense.
- `holdoutCommitment`: commit/reveal boundary for independent evaluation.

The public class methods are deliberately narrow:

| Method | Executable contract |
|---|---|
| `records` | Read the append-only ledger after validation. |
| `append` | Validate bounded, authority-free payloads and append one hash-linked record. |
| `verifyLedger` | Recompute sequence and the complete hash chain. |
| `projection` | Derive current cells, niches, experiments, and deaths from spoor. |
| `ensureBootstrap` | Idempotently create one measurement cell for an empty ecology. |
| `recruit` | Convert bounded proposal/contradiction signals into cells. |
| `metabolize` | Meter token, wall-time, tool, and mutation use. |
| `recordFailure` | Append failure evidence and route recoverable work to a fallback caste. |
| `apoptose` | Quarantine a cell without deleting its lineage. |
| `evaluateExperiment` | Enforce the independent commit/reveal Wall and rollback regressions. |
| `autonomyTurn` | Select work while honoring deadline and operator presence. |
| `snapshot` | Emit the bounded live operator projection. |

The live ledger is `memory/xenobiotic-ecology.ndjson`. It is runtime state and remains ignored by Git; the executable contract and its tests are source-controlled.
