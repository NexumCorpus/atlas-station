import assert from "node:assert/strict";
import { followAutonomyTurn } from "../scripts/autonomy-policy.mjs";

assert.deepEqual(followAutonomyTurn({ rested: false, idleStreak: 3 }), {
  idleStreak: 0, discovery: false, delay: 4000,
});
assert.equal(followAutonomyTurn({ rested: true, idleStreak: 0 }).discovery, false);
assert.equal(followAutonomyTurn({ rested: true, idleStreak: 3 }).discovery, true);
assert.equal(followAutonomyTurn({ rested: true, idleStreak: 3 }).delay, 4000);
assert.equal(followAutonomyTurn({ rested: true, idleStreak: 4 }).idleStreak, 5);

let streak = 0;
const transitions = Array.from({ length: 5 }, () => {
  const next = followAutonomyTurn({ rested: true, idleStreak: streak });
  streak = next.idleStreak;
  return next;
});
assert.deepEqual(transitions.map(t => t.idleStreak), [1, 2, 3, 4, 5]);
assert.deepEqual(transitions.map(t => t.discovery), [false, false, false, true, false]);
assert.deepEqual(transitions.map(t => t.delay), [8000, 16000, 32000, 4000, 128000]);
assert.deepEqual(followAutonomyTurn({ rested: false, idleStreak: streak }), {
  idleStreak: 0, discovery: false, delay: 4000,
});

console.log("autonomy policy: ALL PASS");
