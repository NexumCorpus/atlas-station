# Paid-Problem Radar

The Paid-Problem Radar is Hermes's first native economic sensor. It does not
promise income and it does not submit work. It turns public code-bounty listings
into a deterministic, source-hashed sample and one unapproved local feasibility
packet.

## What it observes

The default scan reads three public Algora organization bounty pages, then
verifies at most the first 20 unique listings against the public GitHub API.
Sources may be replaced with up to eight URLs of exactly this shape:

```text
https://algora.io/<organization>/bounties?status=open
```

The source order and sample size are hashed before fetching. Ranking happens
after the sample is frozen, so a high payout discovered later cannot be inserted
retrospectively. Raw source bytes are not injected into the model; the report
contains their hashes, bounded metadata, and explicitly untrusted titles/labels.

## Economic state is not a synonym for progress

The radar maintains this claim ladder:

- `E0`: a live listing and open issue were independently observed.
- `E1`: the maintainer or platform engaged with a submitted solution.
- `E2`: the contribution was accepted or merged.
- `E3`: net external payment settled.

Only `E1` is evidence of demand for Atlas's work. Only `E3` is revenue. A local
test pass, a pull request, an advertised amount, and even a merge must never be
crystallized as paid income.

## Authority membrane

`economic_radar` has observe authority only. It performs bounded GET requests
to allowlisted Algora and GitHub hosts. It cannot claim an issue, comment, create
a fork, push, open a pull request, publish, spend, or submit identity/payout
information. Its work packet permits only public-rule reading, local source
inspection/reproduction, and an unsent feasibility brief.

Daniel must approve the exact `candidateHash` after these checks are answered:

1. Platform account, jurisdiction, tax, identity, and payout eligibility.
2. Repository license, contribution policy, CLA/DCO, and bounty rules.
3. No accepted, assigned, or materially duplicate solution already exists.
4. The acceptance command reproduces and the task fits a six-hour total budget.

That approval is for one candidate and one bounded attempt. It is not general
permission for outreach or autonomous submission.

## $100/week experiment

The target is a falsifiable hypothesis: one externally settled $100 contribution
per week may become possible after calibration. The first experiment is capped
at two local preflight hours, six total human+model hours, and 48 wall-clock
hours. Retire the vector after three preregistered submissions, 20 total hours,
or four weeks if there are zero `E3` settlements or observed net value remains
below $10/hour.

The denominator includes rejected attempts, duplicate claims, setup, compute,
fees, and operator time. One payment is evidence of one payment, not proof of a
repeatable weekly rate.

## Operation

From the native OpenRouter tool surface:

```text
economic_radar({"minUsd":100,"limit":20})
```

From the provider-neutral Atlas bridge:

```powershell
npm run economic:scan
node scripts/atlas-tool.cjs economic_radar --source=https://algora.io/Dokploy/bounties?status=open --min-usd=100 --limit=20 --capability=typescript
```

Both routes are read-only and return the same schema.
