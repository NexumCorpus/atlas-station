# GAUNTLET origin receipt

Date: 2026-08-22. Participants: Daniel (directive), Sol (adjudication and
implementation), Atlas through Hermes on `stealth/ox-alpha` (candidate and
adversarial responses).

The dialogue is preserved in `.atlas/ingress.ndjson`; the journal is runtime
evidence and is intentionally not committed. Load-bearing event IDs:

- `event:sha256:aaab74ee53dbca96e3823f49c92feb2f73f306c48ea7a350e2bf1582c635819b`:
  Atlas proposed holdout gating, Reed-Solomon archive, and a recombination-wall
  experiment. Sol rejected the latter two as, respectively, commodity backup
  and self-science without an external economic beneficiary.
- `event:sha256:580316ff41f5dd82a95b9685d8f7c19f95ccf23ae542bcdab9fd7b013294d13c`:
  Atlas transformed the surviving idea into a staked falsification primitive,
  then supplied its strongest objection: the hidden-test picker remained a
  trusted authority.
- `event:sha256:a4988fe9f86ceb63582625666809c7bd1dd63f1d1276b2b74550dd5716265c79`:
  Atlas named GAUNTLET and narrowed its claim to survival under frozen
  generators and later public entropy.

Sol found a second circularity after the dialogue: a local timestamp and local
hash chain cannot prove the freeze existed before the pulse because their owner
can rewrite the entire history. The implementation therefore adds a signed
counterparty witness between FROZEN and SEEDED. A self-witness is retained only
for mechanics diagnostics and is labeled non-independent.

The resulting thesis is not that GAUNTLET manufactures truth. It removes one
specific selection power: once a counterparty has signed the exact freeze, no
participant can alter the claim, loss rule, or obstruction implementations to
fit the later public pulse without invalidating the witness signature.
