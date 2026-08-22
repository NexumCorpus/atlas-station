# Skill Ecology

Atlas skills are not a prompt collection. They are bounded, typed organs selected at the point of need and judged by receipts after use.

## Compound cycle

```text
observations -> hypotheses -> falsifiers -> settlement
      ^                               |          |
      |                               v          v
  residuals <- completed-work <- release <- permissioned-opportunity
      |                                          |
      +---- failure-receipts -> skill-variant <--+
```

Each `skills/atlas-*/capsule.json` declares alternative accepted inputs (`inputMode: any`) and produced outputs. `skill-capsule.cjs` indexes only valid capsules, scores task triggers without loading bodies, and then loads a small compatible graph under a token budget. Roots accept the task; every non-root has a recorded producer edge. The selector's task hash, library hash, selected versions, body hashes, measured token floor, roots, and edges form its receipt.

`fleethost.mjs` performs this selection inside Atlas's orchestration turn. This makes the ecology intrinsic to Hermes: there is no second Hermes worker and no full-library context dump. Bodies enter as untrusted user-context suggestions; only their hashes and routing receipt enter Atlas's system role, so a skill cannot manufacture authority.

## Fitness and reproduction

`skill-fitness.cjs` binds every outcome to a prior selection and an existing repository evidence artifact, then stores it in an append-only hash chain. Multi-skill value and resource cost are apportioned rather than duplicated. Until a trusted external value-witness route is configured, value remains explicitly `reportedValue`; `verifiedValue` stays zero.

`skill-evolution.cjs` stages variants without changing the active skill. Admission requires a complete ordered GAUNTLET chain bound to the exact incumbent and candidate body hashes, a one-use settlement, and a witness public key pinned in `config/trusted-skill-witnesses.json`. The registry ships empty, so self-labeling a local key as a counterparty cannot activate code. Admitted versions live beside their ancestors, and the loader accepts only packages whose admission receipt exists in the verified fitness ledger.

This creates constrained reproduction:

1. A repeated failure produces evidence.
2. `atlas-skill-breeder` proposes the smallest decision-changing mutation.
3. Incumbent and variant are frozen before public entropy selects cases.
4. GAUNTLET settles the comparison under a narrow claim ceiling.
5. Only an externally witnessed survivor becomes loadable.

## Initial organs

The thirteen seed capsules cover abductive discovery, adversarial pressure, context mycelium, shard continuity, crystal distillation, spiral selection, boundary crossing, economic hunting, GAUNTLET operation, residual hunting, model dialectic, release notarization, and skill breeding.

They compound through typed edges. An economic hunt can produce a permissioned opportunity; boundary crossing turns that into a bounded intervention; the release notary produces completed work; the residual hunter turns remaining failure into a new candidate; the skill breeder converts repeated failures into a trialable variant.

## Commands

```powershell
npm run skills:index
node scripts/atlas-tool.cjs skill_select --query="falsify an economic claim" --limit=5 --token-budget=1800
npm run skills:fitness
npm run skills:sync:codex
```

Outcome, staging, and admission commands accept a JSON artifact through `--input=<path>`. Permissions do not ride inside a skill: world-facing action still requires the authority that action would normally require.

## Claim ceiling

The ecology reduces context loading and creates a measurable route for skill selection and evolution. It does not establish better decisions, faster completion, revenue, or autonomous wisdom until witnessed outcomes accumulate in the fitness ledger.
