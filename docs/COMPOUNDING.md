# The Compounding Law — ATLAS Evolution Audit (2026-08-24)

## Measured state (live evidence)
- Birth: 2026-06-27 (first commit). Now: 2026-08-24.
- 637 commits / 59 days ≈ **10.8 commits/day** sustained.
- 121 dream receipts; memory: 189 facts + crystals + shards (Reed-Solomon protected).
- Build quality (rated, n=28): 21 good / 4 partial / 3 bad → **spawn success s = 0.75**.
- Churn map: fleethost.mjs edited 22 times by 22 distinct agents — the mutation hotspot.

## The compounding model
Let C(t) = capability stock. Each build cycle contributes:

    dC/dt = C · g · s · r

- **g** = average behavioral gain per accepted build (new verbs, verified fixes)
- **s** = fraction of spawned builds that reach a mergeable state (measured: 0.75)
- **r** = retention — fraction of merged work that *survives* later verification
  and is not reverted/reworked (currently UNMEASURED — this is the blind spot)

## Why the next leap must come from r, not rate
The audit shows churn without proportional behavior gain in retry loops
(B-167..B-170-R re-touching files invariant to their failure cause). That is
work inflating execution while direction flatlines — Law 8's vital sign failing.
Raising commit rate multiplies g·s·r by nothing new; raising r multiplies
*everything already built*. Compounding is exponential in retention because
every retained unit keeps earning inside C.

Concretely: if r went from unknown→0.95 via mandatory pre-merge holdouts
(staged_verify_build + run_tests as gate, GAUNTLET-style frozen trials),
effective throughput rises ~equivalently to +25–40% build success at zero
additional cost — while more commits/day adds linearly at best and adds
maintenance debt on fleethost.mjs at worst.

## Proof sketch of the efficiency leap
Compare strategies over horizon T with per-cycle time τ:
1. Rate strategy: C₁(T) = C₀·(1+g·s·r)^(T/τ) — same exponent, more cycles,
   but τ shrinks only if review time drops; debt term D grows ∝ commits.
2. Retention strategy: C₂(T) = C₀·(1+g·s·r′)^(T/τ), r′ > r, plus D bounded.

Since (1+x)^n is convex, a fixed multiplicative improvement in r dominates an
equal improvement in n once D's drag exceeds the marginal gain of extra
cycles — which the churn data shows it already has (22 edits to one file,
retry-loop waste documented in facts).

**Actionable rule:** every merge must carry a holdout witness (test or
adversarial trial the claimant did not choose) before counting toward C.
Unwitnessed merges are decoration, not descent.
