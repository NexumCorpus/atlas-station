// Independent serialized lanes for Atlas speech and background metabolism.
// Work is FIFO within a lane, but neither lane can head-of-line block the other.
export function createOrchestrationLanes() {
  const tails = { mouth: Promise.resolve(), metabolism: Promise.resolve() };

  function enqueue(lane, work) {
    if (!(lane in tails)) throw new Error(`unknown orchestration lane: ${lane}`);
    if (typeof work !== 'function') throw new TypeError('lane work must be a function');
    const turn = tails[lane].then(work);
    // Keep the lane usable after failure while returning the original rejection.
    tails[lane] = turn.catch(() => {});
    return turn;
  }

  function drain() {
    return Promise.allSettled([tails.mouth, tails.metabolism]);
  }

  return Object.freeze({ enqueue, drain });
}

export function laneTurnBound(lane, env = process.env) {
  const fallback = lane === 'mouth' ? 6 : 64;
  const raw = lane === 'mouth'
    ? env.ATLAS_MOUTH_MAX_TURNS
    : env.ATLAS_ORCHESTRATOR_MAX_TURNS;
  return Math.max(1, Math.min(256, Number(raw) || fallback));
}

export function laneTimeoutMs(lane, env = process.env) {
  if (lane !== 'mouth') return 0;
  return Math.max(5_000, Math.min(120_000, Number(env.ATLAS_MOUTH_TIMEOUT_MS) || 45_000));
}

export function mouthExhaustionHandoff(lane, subtype, userText, maxTurns) {
  if (lane !== 'mouth' || !['error_max_turns', 'mouth_timeout'].includes(subtype)) return null;
  const limit = subtype === 'mouth_timeout' ? 'wall-clock limit' : `${maxTurns}-round conversational bound`;
  return {
    acknowledgement: `I reached the mouth's ${limit}. I have released speech and handed the unfinished work to metabolism.`,
    task: `[MOUTH EXHAUSTION HANDOFF]\nContinue this operator task through Hermes metabolism without repeating conversational preamble. Report the completed result through the normal evidence path.\n\n${String(userText || '')}`,
  };
}
