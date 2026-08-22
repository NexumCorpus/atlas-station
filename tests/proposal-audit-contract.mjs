import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Contract for scripts/audit-proposals.mjs. Hermetic fixtures prove the
// AUDITOR LOGIC (detection + exit codes); the live run proves the standing
// POLICY (ledger clean). The previous version asserted live dirt must EXIST,
// which broke the moment hygiene improved - the exact inversion this
// rewrite removes.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "audit-proposals.mjs");

function runAudit(logPath, historyMode) {
  const env = { ...process.env };
  if (logPath) env.ATLAS_PROPOSAL_LOG = logPath; else delete env.ATLAS_PROPOSAL_LOG;
  if (historyMode) env.ATLAS_PROPOSAL_HISTORY = historyMode; else delete env.ATLAS_PROPOSAL_HISTORY;
  return spawnSync(process.execPath, [script, "--strict"], { cwd: root, encoding: "utf8", env });
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-audit-"));
try {
  // ---- Fixture A: dirty ledger -> exit 2, precise detection ----
  const dirtyLog = path.join(fixtureDir, "dirty.ndjson");
  fs.writeFileSync(dirtyLog, [
    { id: "fx-1", priority: "HIGH", state: "pending", description: "fixture pending high" },
    { id: "fx-2", priority: "HIGH", state: "deferred", description: "fixture incomplete deferral" },
    { id: "fx-3", priority: "HIGH", state: "deferred", description: "fixture complete deferral", nextAction: "act on it now", retryCondition: "retry when evidence changes" },
    { id: "fx-4", priority: "high", state: "retired", description: "fixture retired with receipt", retiredReason: "done" },
    { id: "fx-5", priority: "MEDIUM", state: "pending", description: "fixture medium pending - not HIGH" },
  ].map(function(o){return JSON.stringify(o);}).join("\n") + "\n");
  const dirty = runAudit(dirtyLog, "none");
  assert.equal(dirty.status, 2, "strict audit exits 2 on dirty fixture");
  const dirtyReport = JSON.parse(dirty.stdout);
  assert.equal(dirtyReport.pendingHigh.length, 1, "exactly the pending HIGH is reported");
  assert.equal(dirtyReport.incompleteDeferrals.length, 1, "exactly the incomplete deferral is reported");
  assert.equal(dirtyReport.incompleteDeferrals[0].id, "fx-2");
  assert.deepEqual(dirtyReport.incompleteDeferrals[0].missing, ["nextAction", "retryCondition"]);
  assert.ok(!JSON.stringify(dirtyReport).includes("fx-3"), "complete deferral is not flagged");
  assert.ok(!JSON.stringify(dirtyReport).includes("fx-5"), "MEDIUM pending is out of scope");

  // ---- Fixture B: clean ledger -> exit 0 ----
  const cleanLog = path.join(fixtureDir, "clean.ndjson");
  fs.writeFileSync(cleanLog, JSON.stringify({ id: "fx-ok", priority: "HIGH", state: "consumed", description: "consumed with receipt" }) + "\n");
  const clean = runAudit(cleanLog, "none");
  assert.equal(clean.status, 0, "strict audit exits 0 on clean fixture");

  // ---- Live run: standing policy, not dirt assertion ----
  // The canonical ledger lives in gitignored runtime state, present on the
  // station machine but absent in clean clones/hermetic worktrees. The
  // policy binds wherever the ledger exists; elsewhere fixtures carry the
  // whole contract.
  const liveLedger = path.join(root, "memory", "proposals.ndjson");
  if (fs.existsSync(liveLedger)) {
    const live = runAudit(null, null);
    const liveReport = JSON.parse(live.stdout);
    assert.equal(liveReport.pendingHigh.length, 0, "POLICY: no HIGH proposal may remain pending in the live ledger");
    assert.equal(
      liveReport.incompleteDeferrals.some((p) => /A-144/i.test(p.description || "")),
      false,
      "A-144 repair proposals must never regress to open incomplete deferrals",
    );
    assert.equal(live.status, 0, "POLICY: live proposal ledger audits clean under --strict");
  } else {
    console.log("live ledger absent (hermetic clone) - policy leg skipped");
  }
} finally {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
}

console.log("proposal audit contract: ALL PASS");