# Xenobiotic Ecology

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

The live ledger is `memory/xenobiotic-ecology.ndjson`. It is runtime state and remains ignored by Git; the executable contract and its tests are source-controlled.
