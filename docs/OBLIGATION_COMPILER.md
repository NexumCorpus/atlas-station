# Obligation compiler: contractual mass deletion

The obligation compiler is a bounded proof of multilateral novation discovery.
It reads typed promises as directed edges and finds cycles of three through eight
parties whose incoming and outgoing face values can be replaced by explicit
residual cash settlements. It does not execute, sign, value, or legally approve
anything. Every output has `authority: proposal-only`.

## Input contract

The schema-1 document declares participants, obligations, a source coordinate
and evidence hash for every obligation, expected avoidable fulfillment cost,
novation cost, and Atlas fee in basis points. Every participant must consent to
both adjacent obligation IDs and declare a maximum residual cash tolerance.
Amounts are safe non-negative integer cents; the compiler accepts at most 32
participants, 64 obligations, and cycles of length three through eight.

Evidence hashes cover the exact obligation facts and source coordinate. They
detect changed bytes; they do not prove that the source is authentic or that a
signer consented. Those facts require independent document and identity checks.

## Settlement invariant

For a party in a candidate cycle:

```text
cash delta = incoming face value - outgoing face value
```

The deltas must sum to zero and each delta must remain inside that party's
declared tolerance. Potential net savings are the admitted avoidable fulfillment
costs minus explicit novation cost and the stated Atlas fee. Non-positive plans
are omitted rather than decorated as opportunities.

## Live proof

```text
npm run obligations:proof
node scripts/atlas-tool.cjs compile_obligations --input=path/to/scenario.json
```

The primary proof fetches and hashes four exact SEC EDGAR documents: the executed
April 2025 Mesa/United/Republic Three Party Agreement, its November closing, the
February 2026 final settlement, and the active ten-year Capacity Purchase
Agreement. The filings show 2,744,348 shares valued at $18.84, or $51,703,516,
exchanged for forgiveness and repayment of real debts and obligations. The
active agreement also retains an obligation-assumption mechanism for specified
pass-through purchases. Atlas reports that mechanism as unpriced and review-only.

This proves that contractual mass deletion occurs in real agreements and that
the ingestion route can preserve exact source bytes. It does not prove that the
$51,703,516 was savings, that an unclaimed opportunity remains, or that Atlas has
authority to transact. Material pricing is omitted from the active public filing.

`npm run obligations:diagnostic` contains four fictional parties and is only a
deterministic solver diagnostic. A forged evidence hash, removed consent, or
non-positive economics must eliminate its candidate; it is never market proof.
