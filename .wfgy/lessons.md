## 2026-07-24 — RDE must own verdict state

The previous bridge treated a caller-supplied `claimsPath` and two verdict fields as independent RDE evidence. That was forgeable because Atlas could manufacture the claims file and point RDE at it. The boundary is now artifact-only submission: RDE derives the run ID, owns the managed run files, runs its checker, and returns an honest unknown/fail when its frozen domain cannot grade the artifact.

General rule: a signed receipt authenticates the verifier's output, not caller-owned evidence; verdict-bearing state must be created, hashed, and checked inside the verifier's trusted root.
## 2026-08-20 -- follow the served FSM edge, not a remembered phase sequence
Goal (G): integrate and publicly validate Atlas's claim compiler without mistaking orchestration failures for product failures
What drifted / what went wrong: after DECIDE regressed to SPECIFY, a queued transition targeted PROVE to EXECUTE even though the served built-in graph exposes PROVE to EMIT; the denied edge triggered the bounded-retry circuit.
Fix / resolution: returned to the last valid PROVE checkpoint, used the served legal PROVE to EMIT transition, and recorded the graph mismatch separately from Atlas implementation evidence.
Generalizes to: dispatch one dependent transition at a time and derive the next edge from the latest live response; never queue a remembered phase sequence across a state boundary.
