# Work-Eater: inverse metabolism

Work-Eater is the organism's organ for abolishing recurring work. Ordinary
automation becomes fitter when more work flows through it. Work-Eater has the
opposite objective: it feeds on failed runs, deferred or rejected proposals,
bad outcomes, and xenobiotic failures, then searches for an upstream invariant
that makes that class of work stop existing. Its ideal end state is starvation.

## Executable flow

```text
negative evidence in four independent ledgers
  -> byte-hashed canonical observations
  -> deterministic recurrence signatures
  -> transparent burden score
  -> authority-free abolition contract
  -> xenobiotic caste recruitment
  -> precommitted independent counterfactual holdout
  -> extinction or rollback
```

An abolition contract is invalid if it retries the same action, runs it faster,
hides the outcome, or transfers equivalent cost to another organ. Extinction
requires zero eligible-event recurrence on a holdout committed before candidate
work starts, independent candidate and grader actors, and no displaced token,
wall-time, tool-call, mutation, or operator cost.

## Evidence and continuity

`work-eater-evidence.cjs` admits only observed negative states from:

- `memory/runs.jsonl`
- `memory/proposals.ndjson`
- `memory/outcomes.ndjson`
- `memory/xenobiotic-ecology.ndjson`

Every admitted line keeps its source coordinate and SHA-256 hash. The logical
ledger is `memory/work-eater.ndjson`, an append-only hash chain with a
single-writer lock. Each complete record is fsynced to a pending cell before
append; a successor repairs a torn append, completes a staged append, or
recognizes an already-complete append without duplication. Secret-shaped keys
are normalized before rejection so width and invisible Unicode variants cannot
enter lossless tissue. Full contract/evidence tissue passes through Context
Mycelium into content-addressed Reed-Solomon shards. A compact crystal is added
only when a new contract is born; it is a navigation pointer, never proof.

## Operator surface

```text
npm run work:eat:dry
npm run work:eat
```

Atlas exposes the same path as `abolish_work(limit?, dryRun?)`. The result names
every score component, evidence count and root, contract authority, recruited
ecology cells, Work-Eater ledger head, and Mycelium recovery root.

## Epistemic ceiling

A high burden score means only that the recorded condition recurred. It does
not prove the inferred cause, the value of a proposed intervention, or that
work has been erased. Only `burden-extinct` records backed by the independent
holdout establish local extinction. One recurrence, forged reference,
self-grading actor, late holdout, or displaced cost triggers rollback.
