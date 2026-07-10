# Crystal: whole-body rehearsal (2026-07-10)

Station now has `station organism run`: a fixed deterministic route across
Atlas, RDE, Boundary, EGE, Director2, Demiurge, Station, and Continuity. Each
append-only receipt pins the observed Git revision, marks dirty state rather
than hiding it, retains bounded route evidence, and explicitly grants no
authority to mutate, publish, spend, or promote a hypothesis.

First live receipt: `BODY-ROT 7/8`. Atlas, Boundary, EGE, Director2, Demiurge,
Station, and the Continuity mirror passed; RDE’s full pytest route failed to
return within the honest 30-second wake budget. A Windows process-tree timeout
bug was found and fixed in Station, so deadlines now actually terminate child
trees; the RDE latency remains an exposed organism defect, not a bypassed test.

This is lossless context management by indirection: receipt first, exact bytes
on demand from Git plus the mirror/shard layer. Read the receipt before loading
history; never mistake its compact state pointer for a replacement for the
underlying artifacts.
