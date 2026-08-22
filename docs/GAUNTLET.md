# GAUNTLET

GAUNTLET is a decision instrument for claims whose evaluators must not select
the tests after seeing the answer.

## Protocol

```text
FROZEN -> WITNESSED -> SEEDED -> RUN -> SETTLED -> SUPERSEDED
```

1. Freeze the claim, evidence boundary, executable loss rule, and two through
   eight obstruction-generator implementation hashes.
2. Have a counterparty sign the freeze digest and future-beacon boundary with
   Ed25519. The signature proves that this exact digest was shown to that
   witness; it does not prove who controls the witness key.
3. Admit a NIST Randomness Beacon 2.0 pulse whose timestamp is later than both
   the witness observation and committed future boundary.
4. Derive every concrete trial from the freeze digest, pulse output, generator
   identity, and trial index.
5. Run the declared loss rule, append every result, and emit only the narrow
   survival or failure statement supported by those trials.
6. Append later counterexamples as supersessions. Never rewrite the prior
   receipt.

NIST describes v2 as a beta service. It publishes 512-bit, timestamped, signed,
hash-linked pulses every 60 seconds and exposes a REST endpoint for the next
pulse after a specified time: <https://csrc.nist.gov/projects/interoperable-randomness-beacons/beacon-20>.
This implementation records the service signature but does not yet verify it,
so that limitation is present in every settlement.

## Executable proof

```text
npm run gauntlet:diagnostic
npm run gauntlet:live
npm run gauntlet:inspect
```

The diagnostic generates its own Ed25519 witness and a deterministic fixture
pulse. It proves state ordering, generator freezing, replay, loss evaluation,
ledger integrity, and claim ceilings. It does not prove evaluator independence
or public entropy.

The live route freezes first, self-signs the digest, waits for the next NIST
pulse, and runs two independently implemented RFC 8259 case generators against
Node.js `JSON.parse`. RFC 8259 is the IETF Internet Standard for JSON:
<https://www.rfc-editor.org/rfc/rfc8259>.

Even the live route is self-witnessed. Its maximum claim is that the committed
generator set survived the derived trials under the recorded NIST pulse. A
commercial receipt requires the buyer or another independent party to sign the
freeze digest before the pulse.

## Value experiment

First buyer hypothesis: an ML or software engineering lead deciding whether to
ship a vendor, model, parser, migration, or reliability claim. The buyer already
pays through external evaluation, incident response, duplicated verification,
or the cost of a wrong deployment decision.

The 48-hour experiment is permissioned:

- The buyer supplies one consequential executable claim and its loss function.
- The buyer signs the frozen boundary before the public pulse.
- Hermes runs at least two independently implemented obstruction families.
- The buyer records the decision before and after the receipt.
- Value is measured as verification hours displaced, expected loss avoided, or
  a changed go/no-go decision attributable to a counterexample.

Kill the commercial hypothesis if three qualified buyers will not supply a
claim and witness signature, if generated trials do not change any decision, or
if the cost of constructing obstruction families exceeds the avoided decision
loss. No buyer demand, willingness to pay, avoided loss, or revenue has yet been
demonstrated.
