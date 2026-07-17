import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "fleethost.mjs"), "utf8");
assert.match(source, /function autonomyPrompt\(discovery = false\)/);
assert.match(source, /followAutonomyTurn\(\{ rested: true, idleStreak: autonomyIdleStreak \}\)/);
assert.match(source, /const follow = followAutonomyTurn\(\{ rested, idleStreak: autonomyIdleStreak \}\)/);
assert.doesNotMatch(source, /stopAutonomy\("rested ".*closing early/);
assert.match(source, /send\("autonomy_progress", \{[\s\S]*idleStreak: autonomyIdleStreak,[\s\S]*discovery: follow\.discovery,[\s\S]*nextDelay: autonomyBreather/);
assert.match(source, /catch \(error\) \{[\s\S]*send\("autonomy_progress", \{[\s\S]*failed: true,[\s\S]*failure,[\s\S]*nextDelay: autonomyBreather/);
assert.match(source, /const turnPlan = followAutonomyTurn\(\{ rested: true, idleStreak: autonomyIdleStreak \}\)/);
assert.match(source, /failure,[\s\S]*discovery: turnPlan\.discovery/);
assert.match(source, /This is a forced discovery turn after repeated idle results/);
assert.match(source, /autonomyBusy \|\| _sayBusy\) \{ scheduleAutonomyTick/);
assert.match(source, /const failure = String\(error\?\.message \|\| error\)\.slice\(0, 240\)/);
assert.match(source, /cancelAutonomyTick\(\);[\r\n]+  const m =/);

console.log("autonomy loop contract: ALL PASS");
