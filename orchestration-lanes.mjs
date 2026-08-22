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
