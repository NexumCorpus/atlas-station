// Class-wide turn bound for worker seats (DREAM-408 / B-155 failure class).
// Every query() call site gets a hard tool-round cap unless it declares its own
// (maxTurns) or is the conversational orchestrator seat. Pure module.
export const WORKER_TURN_BOUND = 12;
// Build agents do multi-file work that deterministically needs >12 rounds
// (B-167..B-174/B-215 autopsies: error_max_turns exhaustion, not crashes).
export const BUILD_TURN_BOUND = 30;
// A retry must never rerun under the same bound that exhausted its parent,
// otherwise retries fail identically by construction (fleethost.mjs one-shot retry).
export const RETRY_TURN_BOUND = 45;

export function workerTurnBound(options) {
  if (!options || typeof options !== "object") return WORKER_TURN_BOUND;
  if (options.maxTurns != null) return null; // call site owns its bound
  if (options.atlasMode === "orchestrator") return null; // unbounded conversation seat
  if (options.atlasRetry === true) return RETRY_TURN_BOUND; // elevated retry budget
  if (options.atlasMode === "build") return BUILD_TURN_BOUND;
  return WORKER_TURN_BOUND;
}
