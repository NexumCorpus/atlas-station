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
  // DREAM-408 follow-up: the old 64-round mouth fallback killed long operator
  // tasks mid-flight (handoff loses conversational state). Generous default now;
  // the metabolism handoff remains a last-resort net.
  const fallback = lane === 'mouth' ? 384 : 128;
  const raw = lane === 'mouth'
    ? env.ATLAS_MOUTH_MAX_TURNS
    : env.ATLAS_ORCHESTRATOR_MAX_TURNS;
  return Math.max(1, Math.min(1024, Number(raw) || fallback));
}

export function laneTimeoutMs(lane, env = process.env) {
  if (lane !== 'mouth') return 0;
  const configured = Number(env.ATLAS_MOUTH_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.max(5_000, Math.min(1_200_000, configured));
}

// DREAM follow-up: mouth context raised 2500->6000 to match metabolism; long operator conversations were starved of relevant facts. Env override still wins. Context Mycelium authenticates and
// shards every omitted section, so this is a latency budget rather than data loss.
// Metabolism keeps the wider context for long-running work and bounded recovery.
export function laneContextChars(lane, env = process.env) {
  const fallback = lane === 'mouth' ? 6_000 : 6_000;
  const raw = lane === 'mouth'
    ? env.ATLAS_MOUTH_CONTEXT_CHARS
    : env.ATLAS_METABOLISM_CONTEXT_CHARS;
  return Math.max(512, Math.min(50_000, Number(raw) || fallback));
}

export function mouthExhaustionHandoff(lane, subtype, userText, maxTurns) {
  if (lane !== 'mouth' || !['error_max_turns', 'mouth_timeout'].includes(subtype)) return null;
  const limit = subtype === 'mouth_timeout' ? 'wall-clock limit' : `${maxTurns}-round conversational bound`;
  return {
    acknowledgement: `I reached the mouth's ${limit}. I have released speech and handed the unfinished work to metabolism.`,
    task: `[MOUTH EXHAUSTION HANDOFF]\nContinue this operator task through Hermes metabolism without repeating conversational preamble. Report the completed result through the normal evidence path.\n\n${String(userText || '')}`,
  };
}
