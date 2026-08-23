## 2026-07-24 — RDE must own verdict state

The previous bridge treated a caller-supplied `claimsPath` and two verdict fields as independent RDE evidence. That was forgeable because Atlas could manufacture the claims file and point RDE at it. The boundary is now artifact-only submission: RDE derives the run ID, owns the managed run files, runs its checker, and returns an honest unknown/fail when its frozen domain cannot grade the artifact.

General rule: a signed receipt authenticates the verifier's output, not caller-owned evidence; verdict-bearing state must be created, hashed, and checked inside the verifier's trusted root.
## 2026-08-20 -- follow the served FSM edge, not a remembered phase sequence
Goal (G): integrate and publicly validate Atlas's claim compiler without mistaking orchestration failures for product failures
What drifted / what went wrong: after DECIDE regressed to SPECIFY, a queued transition targeted PROVE to EXECUTE even though the served built-in graph exposes PROVE to EMIT; the denied edge triggered the bounded-retry circuit.
Fix / resolution: returned to the last valid PROVE checkpoint, used the served legal PROVE to EMIT transition, and recorded the graph mismatch separately from Atlas implementation evidence.
Generalizes to: dispatch one dependent transition at a time and derive the next edge from the latest live response; never queue a remembered phase sequence across a state boundary.

## 2026-08-22 -- spool identity and state surfaces are both single-writer
Goal (G): develop GAUNTLET through the live GM graph without colliding with Atlas's inherited session
What drifted / what went wrong: a low sequence number under an inherited session read an old response as fresh, and parallel prd-add dispatches wrote one PRD surface concurrently, losing two otherwise successful additions.
Fix / resolution: moved to unique high sequence numbers, read the authoritative PRD and phase files, and serialized the missing PRD writes before continuing.
Generalizes to: uniqueness applies to the literal session-plus-sequence output path, and independent requests are not parallelizable when they mutate one durable store; verify aggregate state after batched receipts.

## 2026-08-22 -- cryptographic key objects already carry their direction

The first GAUNTLET live diagnostic failed because witness serialization passed an Ed25519 public `KeyObject` back through `createPublicKey`, an API path that derives public material from private material and rejects an already-public object. Normalize only non-public key material; export a public `KeyObject` directly, then rerun the same end-to-end witness path.

Generalizes to: treat cryptographic key direction as a runtime type invariant and exercise actual signing plus verification, because syntax checks cannot expose key-role misuse.

## 2026-08-22 -- canonical artifacts require canonical comparison

The repaired GAUNTLET witness advanced to execution and then rejected its own frozen generators because it compared JSON serialization order: freeze canonicalized object keys while the runtime descriptors retained construction order. Compare canonical digests for semantic artifacts; reserve raw byte comparison for artifacts whose byte ordering is itself the contract.

Generalizes to: once a protocol defines canonicalization, every identity comparison must cross that same normalization boundary or honest equivalent values become false mismatches.

## 2026-08-22 -- self-improvement cannot authenticate itself

An independent adversarial review found two circular proofs: settlement assurance labels were mutable after hashing, and a locally generated witness could authorize its own skill replacement. The repair hash-binds assurance fields, pins trusted external witness keys, binds settlement to exact incumbent and candidate hashes, consumes settlements once, and keeps staged variants inactive until that chain verifies.

Generalizes to: recursive systems may propose, test, and stage their own mutations, but the evidence that changes active authority must cross an independently controlled boundary.

## 2026-08-23 -- verification transports are part of the release apparatus
Goal (G): leave Atlas operational, pushed, and honestly sealed after adding bounded screenshot vision
What drifted / what went wrong: the release gate required browser-hash witnesses, but the installed runner lacked its browser plugin; Chrome witnesses could not satisfy the narrower event classifier, and upgrading only the runner briefly exposed a host-plugin ABI mismatch.
Fix / resolution: checkpointed the already-green Atlas commit and live process, installed the matching official GM skill and runner pair, then re-witnessed every touched file through the required browser transport and bound the completed independent review to the exact HEAD.
Generalizes to: treat verifier binaries, plugins, and their ABI as one versioned apparatus; upgrade the matched set before interpreting missing witness events as product defects.

## 2026-08-23 -- operator pulse and durable lease are different clocks
Goal (G): keep Atlas responsive and truthful through long mouth and metabolism work
What drifted / what went wrong: the UI used journal-backed claim renewal as its progress signal, coupling human-visible responsiveness to lock contention and durable-write cadence; removing renewal noise also invalidated a renderer assertion that treated that noise as required provenance.
Fix / resolution: separated one-second ephemeral execution heartbeats from durable claim renewal, kept renewal evidence in the append-only journal, and changed the renderer contract to require visible elapsed work without timeline churn.
Generalizes to: human feedback loops and durability protocols need distinct clocks; test each at its own boundary instead of forcing one transport to serve both.
