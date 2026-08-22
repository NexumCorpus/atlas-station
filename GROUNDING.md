# GROUNDING - hermes provenance block wiring (verified 2026-08-23)

## Problem (verified live)
memory/runs.jsonl: 350 total runs, 169 carry hermes blocks, ALL 169 fully empty
(provenance:[], completeness zeros/'unknown', falsifiers:[]). Fake receipts, not missing ones.

## Root cause
fleethost.mjs result path (~:403-404): hand-built block copies circulation.legacy()
but OMITS the honesty flag legacy:true, so empties pass circulation.validate()
(memstore.appendRun -> envelope) looking like substance.

## Fix design (pre-verified)
1. Add helper near branchStat (:337): buildHermesRunReceipt(id, actorId, stage,
   proposalLevel, summaryText, extra) using require('./circulation.cjs'):
   - provenance: [{kind:'model-output-summary', ref:`run:${id}`, sha256:textAnchor(persistedSummary)}]
     (memstore persists ONLY summary.slice(0,500), not reply -> anchor the persisted bytes)
   - completeness: {scope:'selected', read_bytes:Buffer.byteLength(summaryText),
     unread_bytes:0, status:'complete'} (honest enum, validate()-clean)
   - loss: {kind:'derived', input_bytes:0, output_bytes:final.length, status:'unmeasured'}
   - falsifiers: [{ref:'holdout:independent-source', status:'pending', independent:true}]
   Wrap call site in try/catch fallback legacy:true (never break terminalization).
2. accumulate toolResultBytes in consume(): add to patch at both tool_result branches
   (~388 ok/fail pair) - String(outText||'').length; include in completeness.read_bytes.
3. Backfill: idempotent script scripts/backfill-legacy-hermes.cjs annotates EXISTING
   169 empty blocks with legacy:true (collapse-until-substantive branch). Terminal
   records are never rewritten, only supplemented (house rule, atlas-session-2026-08-22).
4. ATLAS narrative sites (~:3856 extractAndStore hermes packet, ~:3882 writeSession):
   LATENT BUG VERIFIED BY EXECUTION: appendFact with empty organism packet THROWS
   ('organism memory admission requires an exact source anchor') inside extractAndStore
   try/catch -> ATLAS narrative fact extraction silently stores ZERO facts today.
   Repair: pass anchored packet (shape validated OK vs strict gate):
   provenance:[{kind:'model-output-utf8',ref:'ATLAS:'+date,sha256:textAnchor(full)}],
   completeness selected/complete/0 unread, admission{stale_status fresh,
   falsifier_ref holdout:independent-source, selector independent-holdout},
   falsifiers[{ref,status pending,independent true}].
5. memcontext.cjs:50 STATION_BRIEF says runs.ndjson - actual store is runs.jsonl.

## Constraints
- fleethost.mjs is PURE CRLF (verified 4901 CRLF / 0 bare-LF @ master bcd5dd7).
- Main tree dirty with metabolism-lane work (fleethost/ingress-journal/openrouter)
  - DO NOT touch; verifyManifest rejects activation while treeDirty -> final
    activation gated on that landing (owner: sidecar lineage).
- Protocol: edits in THIS worktree (shadow/hermes-provenance off bcd5dd7),
  gates: node --check, behavioral 78/78, deferred/circulation contracts,
  self-modification.createManifest + test receipts, activation by sidecar lease.
