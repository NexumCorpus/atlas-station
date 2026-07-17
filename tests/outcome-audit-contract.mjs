import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "audit-outcomes.mjs");
const result = spawnSync(process.execPath, [script, "--strict"], { cwd: root, encoding: "utf8" });

assert.equal(result.status, 2, "strict audit should remain blocked by known opaque historical outcomes");
const report = JSON.parse(result.stdout);
assert.equal(report.opaqueBad, 3);
assert.deepEqual(report.opaqueAgents, ["A-132", "A-133", "A-134"]);
assert.deepEqual(report.remediationQueue.map((item) => item.agentId), ["A-132", "A-133", "A-134"]);
assert.ok(report.remediationQueue.every((item) => item.requiredEvidence && item.nextAction));
assert.equal(report.qualityTarget, 0.8);
assert.equal(report.targetMet, false);
assert.equal(report.additionalGoodNeeded, 3);

console.log("outcome audit contract: ALL PASS");
