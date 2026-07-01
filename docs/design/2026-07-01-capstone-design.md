# Capstone: Atlas, Complete

**Date:** 2026-07-01 · **Status:** Spec for review · **Shape chosen:** A (organism) with B (self-account) and C (certified mission) inside it.

## Thesis

Two years of projects each proved one facet of a single question: *how do you build an AI
system that does real work you can trust?* The capstone is the convergence, not a new
project. Atlas-station is the body; the proven organs mount into it; the research corpus
becomes its shipped self-account; and its first dispatched mission is a certified-discovery
campaign whose outcome — hit or null — is reported honestly.

**Capstone demo, one sentence:** the station wakes, remembers, dispatches a discovery
fleet under gm discipline, feels the failures in its nervous system, and only reports
what survived a grader it didn't write.

## What each project contributes

| Organ | Source | Contribution |
|---|---|---|
| Body / GUI / fleet | `E:\atlas-station` | Electron + agent SDK on subscription; fleet worktrees, stigmergy, memory, autodidact |
| Discovery wing | `E:\director2-harness` (over `E:\director2`) | Command packets + RDE v11 cockpit, pure Python, CLI-first |
| Felt state | `E:\director2` nervous system (v1/v2 master, v3 branch) | Un-gameable scars, gut markers, homeostat/self-model |
| Dispatch discipline | gm (`E:\spooltail` recipe) | PLAN→EXECUTE→VERIFY spool; local-bare-origin isolation |
| Verification gates | `E:\emergent-geometry-engine` + RDE v11 | generator≠grader certification; audit bundles; holdout honesty |
| Seam membrane | `E:\chimera` | JS↔Python JSON translation patterns |
| Self-account (B) | Memory journal + director2 docs + eden/demiurge/cross-lab findings | The station's documented, evidence-linked identity |
| First mission (C) | RDE v11 cache-eviction harness | One campaign, audit-bundled, independently graded |

Explicitly out of scope: Arkhona, EternalDom, dreamchannel, the-loop-book, RimWorld — separate tracks.

## Architecture: the Wing Protocol (the one load-bearing decision)

Atlas must talk to Python organs without porting them. One seam contract, file-based and
CLI-native (no HTTP server — matches the standing "lightweight CLI-native" frame):

- **Wing** = an external process described by a `wing.json` manifest: name, launch command,
  health probe, capabilities.
- **Events out**: JSONL on stdout — `status`, `felt-state`, `need`, `claim`.
- **Commands in**: spool directory of JSON command files (gm's proven pattern).
- **Claims are gated**: a `claim` event must reference an audit-bundle path. The station
  renders it *unverified* until a separately-dispatched grader agent (which did not produce
  the claim) certifies the bundle. Certification failure is displayed, not hidden.

First wing: director2-harness. The chimera membrane supplies the translation idioms.

## Phases

**Phase 0 — Foundations (one sweep, sequential):**
1. `git init` + freeze-commit emergent-geometry-engine as-is (certified Phase 0 state must
   be under version control before anything cites it).
2. director2: run the full suite on `exp/dose-response-thoroughness`; if green and
   OFF-path byte-identical (as recorded), merge v3 to master. If not, master stays the base.
3. Write the Wing Protocol v1 schema + a stub echo-wing with an acceptance test.

**Phase 1 — Mount the discovery wing:** Atlas spawns director2-harness as a wing; status
and felt-state stream into the existing fleet UI. Acceptance: a harness demo run visible
live in the station.

**Phase 2 — Nervous system surfaced:** no port. The station *reads* director2's scars /
gut markers / self-model state and renders felt state (converges with existing
`docs/SELF_STATE.md` work). Acceptance: induce a failure in a sandbox run; the scar
appears in the UI and persists across station restart.

**Phase 3 — Claim gate:** implement the grader-dispatch gate on `claim` events, using RDE
v11 audit-bundle format. Acceptance: a deliberately overfit claim is REJECTED and shown as
rejected; a valid claim certifies.

**Phase 4 — Self-account (B), parallel with 1–3:** distill the research corpus into
`docs/self-model/` in atlas-station: what the station is, the norms it holds, and the
evidence (normative valence, cross-lab grounding, demiurge gaming taxonomy, eden
inhabitation), each claim linked to its artifact/bundle. Writing work; dispatchable.

**Phase 5 — First mission (C):** from the station UI, dispatch one cache-eviction
discovery campaign (RDE v11 harness, scrubbed prompts, holdout family, audit bundles),
graded by the Phase-3 gate. Either outcome is capstone-valid: a certified beat, or an
honestly reported null — "only reports what survived" is the thesis.

## Execution mechanics (efficiency)

- **The capstone builds itself with its own discipline**: substantive build work is
  dispatched as gm-driven Sonnet CLI agents in isolated worktrees with local-bare origins;
  I verify independently before integration (standing MO).
- **Parallelism**: Phase 4 runs alongside 1–3. Phases 1→2→3 are sequential (each builds on
  the seam). Phase 0 first, always.
- **Every phase has an immutable acceptance test written before its build dispatch**
  (demiurge lesson: agents do real work under specific+verifiable directives; theater
  otherwise).
- **No pushes to real remotes** at any point without explicit go-ahead.

## Risks

- **Live daemon churn** in atlas-station (dirty tree observed): integrate via worktrees +
  short-lived branches; never build on a dirty master checkout.
- **Windows/Python seams** (paths, UTF-8): known gotchas, handled per playbook.
- **v3 merge risk** in director2: gated by suite + byte-identical check; falls back to master.
- **C nulls**: acceptable by design; the honesty of the report is the demonstrandum.

## Success criteria

One scripted sitting, end to end: wake → self-state + memory visible → one command packet
→ fleet dispatch under gm → induced failure leaves a scar the UI shows → mission claims
pass or fail the independent grader → honest final ledger. Everything runnable from the
station; nothing claimed without a bundle.
