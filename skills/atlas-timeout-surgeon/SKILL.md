name: atlas-timeout-surgeon
description: Diagnose and permanently fix agent timeout and turn-bound failures by classifying the terminal state and changing the failure cause, not adding retries.
---

# Timeout Surgeon

A dead or hung agent is a symptom. Classify before treating; a fix that does not change the cause is not a fix.

## Decision Procedure

1. Classify from terminal state + last mutation timestamp:
   - error_max_turns, recent mutations -> bound exhaustion (real work died mid-flight).
   - no error, no recent mutations, process alive -> silent hang (stalled tool call or event loop).
   - worktree dirty/lock/lease errors -> worktree failure (stale lease or unrecovered state).
   - provider errors (5xx, auth, rate limit) at death -> provider death.
2. Smallest deterministic fix per class:
   - bound exhaustion -> bound scaling (raise or scale the turn bound in providers/turn-bound.mjs).
   - silent hang -> heartbeat with timeout detection and kill/restart on missed beats.
   - retry of an exhausted build -> retry elevation: the retry runs under a HIGHER bound than the failed attempt.
   - worktree failure -> lease recovery: reap stale leases via the durable reaper, never bare timers.
3. The fix must alter the failure CAUSE. A retry under unchanged conditions is invariant to the cause by construction and will fail identically. Retries are never treatment.
4. Before declaring fixed, demand witnessed evidence: one full run of the previously failing task shape completing under the new configuration, with its bound, round count, and outcome recorded in provenance.
