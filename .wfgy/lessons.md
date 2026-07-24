## 2026-07-24 — RDE must own verdict state

The previous bridge treated a caller-supplied `claimsPath` and two verdict fields as independent RDE evidence. That was forgeable because Atlas could manufacture the claims file and point RDE at it. The boundary is now artifact-only submission: RDE derives the run ID, owns the managed run files, runs its checker, and returns an honest unknown/fail when its frozen domain cannot grade the artifact.

General rule: a signed receipt authenticates the verifier's output, not caller-owned evidence; verdict-bearing state must be created, hashed, and checked inside the verifier's trusted root.
