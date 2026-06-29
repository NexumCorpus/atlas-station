/**
 * stigma-backfill.mjs — Replay fleet merge history into STIGMA.json.
 *
 * Reads all fleet merge commits from master, computes decayed heat for each
 * changed file as of now, and upserts into STIGMA.json — giving the pheromone
 * field a real historical gradient on first run.
 *
 * Usage: node scripts/stigma-backfill.mjs [repoPath]
 *   repoPath — defaults to "E:\\atlas-station"
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, renameSync } from "fs";
import path from "path";

const repoPath = process.argv[2] || "E:\\atlas-station";
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

  for (const line of bodyText.split("\n")) {
    const m = line.match(/^(Directive|Rejected|Confidence):\s*(.+)/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "Directive") directives.push(val.trim());
    else if (key === "Rejected") rejected.push(val.trim());
    else if (key === "Confidence") {
      const f = parseFloat(val);
      if (!isNaN(f) && f >= 0 && f <= 1) confidence = f;
    }
  }

  return { directives, rejected, confidence };
}

// Extract fleet branch name from merge subject, e.g.:
//   "Merge branch 'fleet/B-110'"  → "fleet/B-110"
//   "merge fleet/B-108: ..."      → "fleet/B-108"
function extractBranch(subject) {
  const m = subject.match(/fleet\/([^\s':]+)/);
  return m ? "fleet/" + m[1] : null;
}

// Load existing STIGMA.json (or start fresh)
function loadStigma() {
  try {
    const raw = readFileSync(stigmaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version != null) return parsed;
  } catch (_) {}
  return { version: 1, updated: null, subsystems: {} };
}

function dedup(arr) {
  return [...new Set(arr)];
}

// Step 1 — get all fleet merge commits, oldest first
let mergeLines;
try {
  mergeLines = git("log", "master", "--merges", "--format=%H %ct %s")
    .split("\n")
    .filter(l => l && /fleet\//.test(l))
    .reverse(); // oldest first
} catch (e) {
  console.error("[stigma-backfill] Could not read git log:", e.message);
  process.exit(0);
}

const stigma = loadStigma();
if (!stigma.subsystems) stigma.subsystems = {};

let mergesProcessed = 0;
const nowMs = Date.now();

for (const line of mergeLines) {
  try {
    const spaceIdx = line.indexOf(" ");
    const rest = line.slice(spaceIdx + 1);
    const spaceIdx2 = rest.indexOf(" ");

    const hash       = line.slice(0, spaceIdx);
    const epochSec   = parseInt(rest.slice(0, spaceIdx2), 10);
    const subject    = rest.slice(spaceIdx2 + 1);
    const epochMs    = epochSec * 1000;

    const branchName = extractBranch(subject);
    if (!branchName) continue;

    // Extract agent ID from branch name e.g. "fleet/B-108" → "B-108"
    const agentId = branchName.replace("fleet/", "");

    // Get changed files in this merge (diff vs first parent)
    let changedFiles = [];
    try {
      const diffOut = git("diff", hash + "^1", hash, "--name-only");
      changedFiles = diffOut.split("\n").map(s => s.trim()).filter(Boolean);
    } catch (_) {
      // Some merges may not have a ^1 (rare root merges) — skip
      continue;
    }

    if (!changedFiles.length) continue;

    // Get trailers from the ^2 parent (fleet branch tip commit body)
    let body = "";
    try {
      const logOut = git("log", hash + "^2", "-1", "--format=%b");
      body = logOut;
    } catch (_) {
      // Might not have ^2 if it's a squash/fast-forward — try the merge commit body
      try {
        body = git("log", hash, "-1", "--format=%b");
      } catch (_2) {}
    }

    const { directives, rejected, confidence } = parseTrailers(body);

    // Compute decayed heat: started at 1.0 at merge time, decayed to now
    const hoursSince = (nowMs - epochMs) / 3_600_000;
    const heat = Math.exp(-Math.LN2 * hoursSince / 4);

    // Compute last_touched ISO from epoch
    const last_touched = new Date(epochMs).toISOString();

    // Upsert: later commits overwrite earlier ones for heat/agent/timestamp.
    // For directives/rejected we accumulate and cap (same as stigma-write).
    for (const filePath of changedFiles) {
      const existing = stigma.subsystems[filePath];
      if (existing) {
        // Later commit wins on heat/agent/timestamp only if it's newer
        const existingTs = existing.last_touched ? new Date(existing.last_touched).getTime() : 0;
        if (epochMs >= existingTs) {
          stigma.subsystems[filePath] = {
            heat,
            confidence,
            last_agent:   agentId,
            last_touched,
            directives:   dedup((existing.directives || []).concat(directives)).slice(-5),
            rejected:     dedup((existing.rejected   || []).concat(rejected)).slice(-10),
          };
        } else {
          // Earlier commit — only accumulate directives/rejected
          stigma.subsystems[filePath].directives = dedup(
            directives.concat(existing.directives || [])
          ).slice(-5);
          stigma.subsystems[filePath].rejected = dedup(
            rejected.concat(existing.rejected || [])
          ).slice(-10);
        }
      } else {
        stigma.subsystems[filePath] = {
          heat,
          confidence,
          last_agent:   agentId,
          last_touched,
          directives:   dedup(directives).slice(-5),
          rejected:     dedup(rejected).slice(-10),
        };
      }
    }

    mergesProcessed++;
  } catch (e) {
    // Per-commit try/catch — skip on failure
    process.stderr.write(`[stigma-backfill] Skipped commit: ${e.message}\n`);
  }
}

// Update timestamp and write atomically
stigma.updated = new Date().toISOString();
writeFileSync(stigmaTmpPath, JSON.stringify(stigma, null, 2), "utf8");
renameSync(stigmaTmpPath, stigmaPath);

const subsystemCount = Object.keys(stigma.subsystems).length;
console.log(`[stigma-backfill] Backfilled ${subsystemCount} subsystems from ${mergesProcessed} fleet merges`);
