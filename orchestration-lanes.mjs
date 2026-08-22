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

export function mouthExhaustionHandoff(lane, subtype, userText, maxTurns) {
  if (lane !== 'mouth' || subtype !== 'error_max_turns') return null;
  return {
    acknowledgement: `I reached the mouth's ${maxTurns}-round conversational bound. I have released speech and handed the unfinished work to metabolism.`,
    task: `[MOUTH EXHAUSTION HANDOFF]\nContinue this operator task through Hermes metabolism without repeating conversational preamble. Report the completed result through the normal evidence path.\n\n${String(userText || '')}`,
  };
}
