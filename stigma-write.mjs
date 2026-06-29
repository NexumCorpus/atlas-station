/**
 * stigma-write.mjs — Stigmergy exit ritual for ATLAS build agents.
 *
 * Updates STIGMA.json with pheromone traces from a completed build:
 * which files were touched, confidence, directives, and rejected approaches.
 *
 * Call signature: node stigma-write.mjs <agentId> <fullBranchName> [repoPath]
 *   agentId        — e.g. "B-108"
 *   fullBranchName — e.g. "fleet/B-108" (includes fleet/ prefix)
 *   repoPath       — defaults to "E:\\atlas-station"
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const argv = process.argv;
const agentId  = argv[2];
const branch   = argv[3];
const repoPath = argv[4] || "E:\\atlas-station";

const stigmaPath    = path.join(repoPath, "STIGMA.json");
const stigmaTmpPath = path.join(repoPath, "STIGMA.json.tmp");

function git(...args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function parseTrailers(bodyText) {
  const directives = [];
  const rejected   = [];
  let confidence   = 0.4;
  let scopeRisk    = "";

  for (const line of bodyText.split("\n")) {
    const m = line.match(/^(Directive|Rejected|Confidence|Scope-risk):\s*(.+)/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "Directive") directives.push(val.trim());
    else if (key === "Rejected") rejected.push(val.trim());
    else if (key === "Confidence") {
      const f = parseFloat(val);
      if (!isNaN(f) && f >= 0 && f <= 1) confidence = f;
    } else if (key === "Scope-risk") {
      scopeRisk = val.trim();
    }
  }

  return { directives, rejected, confidence, scopeRisk };
}

function dedup(arr) {
  return [...new Set(arr)];
}

function applyDecay(subsystems, halfLifeHours) {
  const now = Date.now();
  for (const [key, entry] of Object.entries(subsystems)) {
    if (!entry.last_touched) continue;
    const hoursSince = (now - new Date(entry.last_touched).getTime()) / 3_600_000;
    entry.heat = (entry.heat || 1.0) * Math.exp(-Math.LN2 * hoursSince / halfLifeHours);
  }
}

try {
  if (!agentId || !branch) {
    process.stderr.write("[stigma-write] Error: agentId and branch are required\n");
    process.exit(0);
  }

  // Step 2: Get commit info
  let hash = "", subject = "", body = "";
  try {
    const logOut = git("log", branch, "-1", "--format=%H%n%s%n%b");
    const lines = logOut.split("\n");
    hash    = lines[0] || "";
    subject = lines[1] || "";
    body    = lines.slice(2).join("\n");
  } catch (e) {
    process.stderr.write(`[stigma-write] Warning: could not get commit log for ${branch}: ${e.message}\n`);
  }

  // Step 3: Get changed files
  let changedFiles = [];
  try {
    const diffOut = git("diff", `${branch}^..${branch}`, "--name-only");
    changedFiles = diffOut.split("\n").map(s => s.trim()).filter(Boolean);
  } catch (_) {
    // Fallback: single-commit branch with no parent
    try {
      const treeOut = git("diff-tree", "--no-commit-id", "-r", "--name-only", branch);
      changedFiles = treeOut.split("\n").map(s => s.trim()).filter(Boolean);
    } catch (e2) {
      process.stderr.write(`[stigma-write] Warning: could not get changed files for ${branch}: ${e2.message}\n`);
    }
  }

  // Step 4: Parse trailers
  const { directives, rejected, confidence, scopeRisk } = parseTrailers(body);

  // Step 5: Load STIGMA.json
  let stigma;
  try {
    stigma = JSON.parse(readFileSync(stigmaPath, "utf8"));
    if (!stigma || typeof stigma !== "object" || stigma.version == null) {
      throw new Error("invalid structure");
    }
  } catch (_) {
    stigma = { version: 1, updated: null, subsystems: {} };
  }
  if (!stigma.subsystems) stigma.subsystems = {};

  // Step 6: Apply temporal decay (4-hour half-life)
  applyDecay(stigma.subsystems, 4);

  // Step 7: Write pheromone traces for each changed file
  const now = new Date().toISOString();
  for (const filePath of changedFiles) {
    const existing = stigma.subsystems[filePath] || {};
    stigma.subsystems[filePath] = {
      heat:         1.0,
      confidence,
      last_agent:   agentId,
      last_touched: now,
      directives:   dedup((existing.directives || []).concat(directives)).slice(-5),
      rejected:     dedup((existing.rejected   || []).concat(rejected)).slice(-10),
    };
  }

  // Step 8: Update timestamp
  stigma.updated = now;

  // Step 9: Atomic write
  writeFileSync(stigmaTmpPath, JSON.stringify(stigma, null, 2), "utf8");
  renameSync(stigmaTmpPath, stigmaPath);

  // Step 10: Report
  console.log(`[stigma-write] ${agentId}: updated ${changedFiles.length} subsystems`);
} catch (err) {
  process.stderr.write(`[stigma-write] Fatal: ${err.message}\n`);
  // Always exit 0 — never block the caller
  process.exit(0);
}
