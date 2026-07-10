# Fable 5 capability manifest

This is an evidence-backed index of the estate tools and skill contracts left
by Fable 5. It is a pointer map: read the named source before using a contract;
do not copy its prose into a new prompt.

## Estate operating skills

| Capability | Canonical skill | What it supplies |
|---|---|---|
| Wake / lossless context recovery | `C:\Users\dalea\.claude\skills\station-wake\SKILL.md` | `station wake`, cursor-only log reads, spine, suites, wills, grimoire, errata, drift, witness, backup |
| Measured self-improvement | `C:\Users\dalea\.claude\skills\spiral\SKILL.md` | One built and verified turn, before/after measure, kill condition, `station seal`, commit, backup |
| Lossless context molt | `C:\Users\dalea\.claude\skills\molt\SKILL.md` | Testament, handoff, wake-after-clear, and a rule against relying on transcript memory |
| Dense dispatch | `C:\Users\dalea\.claude\skills\dense-dispatch\SKILL.md` | Capsule-first work briefs, parameterized plays, SPOOR verdict/PIN report contract |
| Certified claims | `C:\Users\dalea\.claude\skills\certify-claim\SKILL.md` | Separate generator/grader, fixed holdouts, claim bundle, explicit certification or rejection |
| Pre-registered experiments | `C:\Users\dalea\.claude\skills\preregistered-sweep\SKILL.md` | Frozen recipe, controls, per-instance artifacts, null discipline, interruption-safe sweep output |

## Recursive discovery skills

| Capability | Canonical skill | What it supplies |
|---|---|---|
| Multi-role discovery | `E:\recursive-discovery-engine\skills\multi-role-discovery\SKILL.md` | Builder / Adversary / Synthesizer separation, grounding, novelty checks, objective stop decisions |
| Pareto reward | `E:\recursive-discovery-engine\skills\pareto-frontier\SKILL.md` | Marginal-hypervolume gain: zero reward for dominated/recombinant work; ship within a fixed budget |
| Grounded execution | `E:\recursive-discovery-engine\skills\grounded-code-execution\SKILL.md` | Static screen, isolated subprocess, timeout/memory cap, trusted oracle, completeness gate |
| AST safety screen | `E:\recursive-discovery-engine\skills\ast-safety-screen\SKILL.md` | Cheap structural rejection before executing untrusted generated Python |

## Native Hermes organs to invoke through Station

- `E:\station\station.py`: wake, log cursors, spine, will/handoff, suite verification, drift/witness/backup, seals, shards, sutures, organism rehearsal, and Hermes reads.
- `E:\station\hermes.py`: bounded reader implementation. It is one local reader organ, not Hermes itself.
- `E:\station\plays\spiral-turn.md`: execution shape for a measured spiral.
- `E:\station\shard_rs.py` and `E:\station\checks\shards.py`: deterministic Reed-Solomon loss repair and verification.
- `E:\station\research\hermes-local.md`: historical research context for the reader organ.

## Admission rule

The organism is Hermes. These skills are not a menu of decorative personas:
they are executable contracts. Before a self-improvement change, select the
smallest applicable contract, read its canonical file, record its falsifier,
and preserve NULL / FAIL / BLOCKED outcomes as evidence. A result enters
memory or routing only through the Hermes circulation envelope and its
independent falsifier rule.
