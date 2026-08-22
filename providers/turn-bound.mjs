// Class-wide turn bound for worker seats (DREAM-408 / B-155 failure class).
// Every query() call site gets a hard tool-round cap unless it declares its own
// (maxTurns) or is the conversational orchestrator seat. Pure module: no side
// effects, safe to unit-test and import from any terminal.
export const WORKER_TURN_BOUND = 12;

export function workerTurnBound(options) {
  if (!options || typeof options !== "object") return WORKER_TURN_BOUND;
  if (options.maxTurns != null) return null; // call site owns its bound
  if (options.atlasMode === "orchestrator") return null; // unbounded conversation seat
  return WORKER_TURN_BOUND;
}