import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "audit-proposals.mjs");
const result = spawnSync(process.execPath, [script, "--strict"], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 2, "strict proposal audit should expose existing incomplete deferred records");
const report = JSON.parse(result.stdout);
assert.equal(report.pendingHigh.length, 0, "no HIGH proposal may remain pending");
assert.ok(report.incompleteDeferrals.length > 0, "historical incomplete deferrals must remain visible");
assert.equal(
  report.incompleteDeferrals.some((p) => /A-144/i.test(p.description || "")),
  false,
  "A-144 repair proposals must not remain open as incomplete deferrals"
);

console.log("proposal audit contract: ALL PASS");
