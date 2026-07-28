import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "audit-outcomes.mjs");
const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-outcomes-"));
const require = createRequire(import.meta.url);
const tracker = require(path.join(root, "outcome-tracker.cjs"));
const fixtures = [
  { agentId: "A-132", rating: "bad", notes: "auto-tagged: unknown", failureMode: "unknown" },
  { agentId: "A-133", rating: "bad", notes: "auto-tagged: unknown", failureMode: "unknown" },
  { agentId: "A-134", rating: "bad", notes: "auto-tagged: unknown", failureMode: "unknown" },
  ...Array.from({ length: 12 }, (_, index) => ({ agentId: `GOOD-${index}`, rating: "good", notes: "verified fixture" })),
];
fs.writeFileSync(path.join(memDir, "outcomes.ndjson"), fixtures.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

let result = spawnSync(process.execPath, [script, "--strict", memDir], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 2, "strict audit blocks unresolved opaque outcomes");
let report = JSON.parse(result.stdout);
assert.equal(report.opaqueBad, 3);
assert.deepEqual(report.opaqueAgents, ["A-132", "A-133", "A-134"]);
assert.deepEqual(report.remediationQueue.map((item) => item.agentId), ["A-132", "A-133", "A-134"]);
assert.ok(report.remediationQueue.every((item) => item.requiredEvidence && item.nextAction));
assert.equal(report.qualityTarget, 0.8);
assert.equal(report.targetMet, true);
assert.equal(report.additionalGoodNeeded, 0);

for (const agentId of ["A-132", "A-133", "A-134"]) {
  tracker.dispositionOutcome(
    agentId,
    "retired",
    "Repository-wide recovery found no surviving causal context; preserve the bad outcome and retire its opaque classification.",
    [{ kind: "recovery-search", scope: "repository", result: "no-context-found" }],
    memDir,
  );
}
const duplicate = tracker.dispositionOutcome(
  "A-132",
  "retired",
  "Repository-wide recovery found no surviving causal context; preserve the bad outcome and retire its opaque classification.",
  [{ kind: "recovery-search", scope: "repository", result: "no-context-found" }],
  memDir,
);
assert.equal(duplicate.seq, 1, "disposition writes are idempotent");
result = spawnSync(process.execPath, [script, "--strict", memDir], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
report = JSON.parse(result.stdout);
assert.equal(report.opaqueBad, 0);
assert.equal(report.resolvedOpaqueBad, 3);
assert.equal(report.dispositionLedger.valid, true);
assert.deepEqual(report.resolvedOpaqueAgents.map((item) => item.agentId), ["A-132", "A-133", "A-134"]);
assert.ok(report.resolvedOpaqueAgents.every((item) => item.disposition === "retired" && item.evidence.length));

const dispositionFile = path.join(memDir, "outcome-dispositions.ndjson");
const tampered = fs.readFileSync(dispositionFile, "utf8").replace("no-context-found", "forged-context");
fs.writeFileSync(dispositionFile, tampered);
result = spawnSync(process.execPath, [script, "--strict", memDir], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 2, "strict audit rejects a tampered disposition chain");

console.log("outcome audit contract: ALL PASS");
