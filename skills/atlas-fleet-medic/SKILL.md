---
name: atlas-fleet-medic
description: Diagnose and prevent subagent turn-exhaustion by consolidating scope and bounding rounds before scheduling work or retries.
---

# Fleet Medic

Treat subagent exhaustion (error_max_turns) as a scope disease, not a stamina problem. An agent that mutated many files before dying did real work under an impossible budget — the fix is consolidation and bounds, never more identical attempts.

## Pattern

1. Consolidate multi-deliverable tasks into ONE agent with a hard round budget of ~8. Splitting one coherent deliverable across agents multiplies coordination rounds past any bound.
2. Cap reads explicitly: 'read at most 3 files'. Unbounded exploration is the silent consumer of round budgets.
3. Build workers run with 30 rounds; retries get 45 via providers/turn-bound.mjs. Verify the bound actually in force before predicting survival.
4. Never schedule a retry under an unchanged bound. A retry that re-runs the identical task against the identical cap is invariant to the failure cause by construction and will fail identically.

Emit the observed failure class, the bound in effect at death, the consolidation decision, and the new bound. Escalating retries without changing the bound is not treatment.
