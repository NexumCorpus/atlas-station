/**
 * stigma-read.mjs — Agent startup ritual: read the pheromone field.
 *
 * Returns cold zones — subsystems with low heat and low confidence —
 * as JSON to stdout. Cold zones are where improvement effort is most
 * needed and least duplicated.
 *
 * Usage: node stigma-read.mjs [repoPath] [--top N]
 *   repoPath — defaults to "E:\\atlas-station"
 *   --top N  — return N cold zones (default 5)
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Parse args: optional repoPath (doesn't start with --), optional --top N
let repoPath = "E:\\atlas-station";
let topN = 5;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--top" && process.argv[i + 1]) {
    topN = parseInt(process.argv[i + 1], 10) || 5;
    i++;
  } else if (!arg.startsWith("--")) {
    repoPath = arg;
  }
}

const stigmaPath = path.join(repoPath, "STIGMA.json");

function git(...args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// Load STIGMA.json
let stigma;
try {
  if (!existsSync(stigmaPath)) throw new Error("absent");
  stigma = JSON.parse(readFileSync(stigmaPath, "utf8"));
  if (!stigma || !stigma.subsystems || !Object.keys(stigma.subsystems).length) {
    throw new Error("empty");
  }
} catch (_) {
  console.log(JSON.stringify({
    coldZones: [],
    message: "No pheromone field yet — run stigma-backfill.mjs",
  }));
  process.exit(0);
}

const nowMs = Date.now();

// Apply temporal decay to all entries, then score
const scored = [];
for (const [filePath, entry] of Object.entries(stigma.subsystems)) {
  let heat = entry.heat || 0;
  if (entry.last_touched) {
    const hoursSince = (nowMs - new Date(entry.last_touched).getTime()) / 3_600_000;
    heat = heat * Math.exp(-Math.LN2 * hoursSince / 4);
  }

  const confidence = entry.confidence != null ? entry.confidence : 0.4;

  // attraction = (1 - confidence) * (1 - heat)
  // Max (1.0) when heat=0 and confidence=0 — cold and unknown
  // Min (0.0) when heat=1 and confidence=1 — hot and well-known
  const attraction = (1.0 - confidence) * (1.0 - heat);

  scored.push({ filePath, heat, confidence, attraction, entry });
}

// Sort by attraction descending, take top N
scored.sort((a, b) => b.attraction - a.attraction);
const topZones = scored.slice(0, topN);

// Fetch recent git trailers for each cold zone.
// Uses %b (commit body) so --format comes before -- and is interpreted correctly.
// Parses the same Directive:/Rejected:/Confidence: pattern as stigma-write.mjs.
function getTrailers(filePath) {
  const directives = [];
  const rejected = [];
  try {
    const out = git("log", "-5", "--format=%b", "--", filePath);
    for (const line of out.split("\n")) {
      const m = line.match(/^(Directive|Rejected|Constraint):\s*(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === "Directive" || key === "Constraint") directives.push(val.trim());
      else if (key === "Rejected") rejected.push(val.trim());
    }
  } catch (_) {
    // File might not exist in git — skip gracefully
  }
  return { directives: [...new Set(directives)].slice(-5), rejected: [...new Set(rejected)].slice(-5) };
}

// Also check STIGMA.json's stored directives/rejected (from stigma-write)
function mergeStoredTrailers(entry, gitTrailers) {
  const stored_d = entry.directives || [];
  const stored_r = entry.rejected || [];
  const directives = [...new Set([...stored_d, ...gitTrailers.directives])].slice(-5);
  const rejected   = [...new Set([...stored_r, ...gitTrailers.rejected])].slice(-5);
  return { directives, rejected };
}

const coldZones = topZones.map(({ filePath, heat, confidence, attraction, entry }) => {
  const gitTrailers = getTrailers(filePath);
  const { directives, rejected } = mergeStoredTrailers(entry, gitTrailers);

  return {
    path: filePath,
    attraction: Math.round(attraction * 1000) / 1000,
    heat: Math.round(heat * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    last_agent: entry.last_agent || null,
    last_touched: entry.last_touched || null,
    directives,
    rejected,
  };
});

console.log(JSON.stringify({
  coldZones,
  timestamp: new Date().toISOString(),
  totalSubsystems: Object.keys(stigma.subsystems).length,
}, null, 2));
