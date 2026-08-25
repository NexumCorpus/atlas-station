// retention.cjs - pre-merge holdout gate for fleet auto-merges.
// stagedHoldout(agentId): stage the agent's fleet/<id> branch on a temp branch
// off master in a throwaway worktree, run node --check on every changed
// JS/MJS/CJS file AND the behavioral test suite against the staged tree,
// then clean up. Never touches master. Returns { pass, failedTests, filesChecked }.
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function stagedHoldout(agentId, opts) {
  const dir = (opts && opts.dir) || process.cwd();
  const git = (gitArgs, cwd) =>
    execFileSync("git", ["-C", cwd || dir, ...gitArgs], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const branch = "fleet/" + agentId;
  const suffix = Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  const temp = "holdout-temp-" + String(agentId).replace(/[^A-Za-z0-9._-]/g, "_") + "-" + suffix;
  const verifyDir = path.join(path.dirname(dir), temp);
  const cleanup = () => {
    try { git(["worktree", "remove", "--force", verifyDir]); } catch (_) {}
    try { git(["branch", "-D", temp]); } catch (_) {}
  };
  try {
    fs.mkdirSync(path.dirname(verifyDir), { recursive: true });
    git(["worktree", "add", "-f", "-b", temp, verifyDir, "master"]);
    try {
      git(["merge", "--no-ff", "--no-commit", branch], verifyDir);
    } catch (e) {
      cleanup();
      return { pass: false, failedTests: ["merge-conflict:" + branch], filesChecked: [] };
    }
    const diff = git(["diff", "--name-only", "master", branch]);
    const filesChecked = diff.trim().split("\n").filter(f => f && /\.(js|mjs|cjs)$/.test(f));
    for (const rel of filesChecked) {
      try {
        execFileSync(process.execPath, ["--check", path.join(verifyDir, rel)], { timeout: 15000 });
      } catch (e) {
        cleanup();
        return { pass: false, failedTests: ["node --check failed: " + rel], filesChecked };
      }
    }
    let failedTests = [];
    try {
      const out = execFileSync(process.execPath, [path.join(verifyDir, "tests", "behavioral.mjs")],
        { cwd: verifyDir, encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
      const text = String(out || "");
      const m = text.match(/(\d+) failed/);
      if (m && parseInt(m[1]) > 0) {
        failedTests = text.split("\n").filter(l => l.trim().startsWith("FAIL:")).slice(0, 10);
        if (!failedTests.length) failedTests = [m[0] + " behavioral failures"];
      }
    } catch (e) {
      const text = String((e.stdout || "") + (e.stderr || ""));
      failedTests = text.split("\n").filter(l => l.trim().startsWith("FAIL:")).slice(0, 10);
      if (!failedTests.length) failedTests = ["behavioral suite error: " + String(e.message).slice(0, 200)];
    }
    cleanup();
    return { pass: failedTests.length === 0, failedTests, filesChecked };
  } catch (e) {
    cleanup();
    return { pass: false, failedTests: ["stagedHoldout error: " + String(e.message).slice(0, 200)], filesChecked: [] };
  }
}

const METRICS_FILE = path.join(".atlas", "receipts", "holdout-metrics.ndjson");
function recordHoldoutMetric(outcome, agentId) {
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    fs.appendFileSync(METRICS_FILE,
      JSON.stringify({ ts: new Date().toISOString(), outcome, agentId }) + "\n", "utf8");
  } catch (_) {}
}
function holdoutMetrics() {
  try {
    const lines = fs.readFileSync(METRICS_FILE, "utf8").trim().split("\n").filter(Boolean);
    let accepted = 0, rejected = 0;
    for (const l of lines) { try { const o = JSON.parse(l); if (o.outcome === "accepted") accepted++; else if (o.outcome === "rejected") rejected++; } catch (_) {} }
    return { accepted, rejected, total: accepted + rejected };
  } catch (_) { return { accepted: 0, rejected: 0, total: 0 }; }
}

// ---- Post-merge retention ledger (vital sign r) ----
const RETENTION_FILE = path.join("memory", "retention.ndjson");

function appendRetentionRecord(repoDir, rec) {
  const file = path.isAbsolute(RETENTION_FILE) ? RETENTION_FILE : path.join(repoDir || process.cwd(), RETENTION_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}

function readRetentionEvents(repoDir) {
  const file = path.isAbsolute(RETENTION_FILE) ? RETENTION_FILE : path.join(repoDir || process.cwd(), RETENTION_FILE);
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

// Classify each merge as survived/regressed/unknown using retention events
// and build-outcome ratings recorded AFTER the merge timestamp.
function computeRetention(merges, opts) {
  opts = opts || {};
  const events = Array.isArray(opts.events) ? opts.events : [];
  const outcomes = Array.isArray(opts.outcomes) ? opts.outcomes : [];
  let survived = 0, regressed = 0;
  const detail = [];
  for (const m of merges) {
    const ev = events.find(e => e.agentId === m.agentId && e.mergeCommit === m.hash);
    let verdict = "unknown";
    if (ev && (ev.verdict === "stayed" || ev.verdict === "survived")) verdict = "survived";
    else if (ev && ev.verdict === "regressed") verdict = "regressed";
    else {
      const oc = outcomes.find(o => o.agentId === m.agentId && o.ts && new Date(o.ts).getTime() / 1000 >= m.ts);
      if (oc && oc.rating === "good") verdict = "survived";
      else if ((oc && oc.rating === "bad") || (ev && ev.verdict === "reverted")) verdict = "regressed";
    }
    if (verdict === "survived") survived++;
    else if (verdict === "regressed") regressed++;
    detail.push({ agentId: m.agentId, mergeCommit: m.hash, verdict });
  }
  const total = merges.length;
  const classified = survived + regressed;
  return {
    merges: total, survived, regressed, unknown: total - classified,
    r: classified > 0 ? Number((survived / classified).toFixed(4)) : null,
    detail,
    windowDays: opts.windowDays || null,
  };
}

module.exports = { stagedHoldout, recordHoldoutMetric, holdoutMetrics, appendRetentionRecord, readRetentionEvents, computeRetention };
