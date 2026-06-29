# AUTODIDACT

ATLAS self-directed improvement engine. Analyzes operational data and implements targeted upgrades.

## Phase 1 Improvements ("2026-06-2)

1. Added validate_facts tool to fleethost.mjs that scans memory/facts.ndjson for Windows file-path references matching common source extensions, removes facts where any referenced path no longer exists, rewrites the file with only valid facts, and returns a count summary; registered it in the fleetServer tools array, ORCH_ROLE shortref index, self_assess list, capability_manifest array, and SELF_STATE.md pulse (tool count updated from 64 to 65).
2. Replaced the dream protocol in daemon-run.mjs step 4 with a grounded version requiring build_outcomes() first, and added a corresponding standing rule prohibiting dreams without observed failure data.
3. Removed the `tier !== 'build'` guard from the resonance re-rank block in `memcontext.cjs` and dropped the build-tier `factLimit` cap of 2, so build agents now receive the same task-relevance-ranked fact recall as orchestrator agents.

## The Cycle

1. `build_outcomes()` -- find common failure patterns
2. `memory_health()` + `validate_facts()` -- audit fact quality
3. `propose_improvement()` -- proposals targeting observed failures only
4. `triage_proposals()` -- score and prioritize
5. `auto_build()` -- implement top proposals
6. `run_tests()` + `staged_verify_build()` -- gate: no merge without behavioral pass
7. `capture_insight()` -- document what changed and why

## Standing Rule

Every proposal must cite which build_outcomes() failure pattern it addresses.
No proposal is valid without observed failure data backing it.
