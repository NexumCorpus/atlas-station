#!/usr/bin/env node
// Read-only build-outcome quality audit. Historical records are never rewritten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { additionalGoodNeeded } from "./quality-metrics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "memory", "outcomes.ndjson");
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
const outcomes = lines.map((line) => JSON.parse(line));
const bad = outcomes.filter((entry) => entry.rating === "bad");
const opaque = bad.filter((entry) =>
  entry.failureMode === "unknown" || /^(unknown|auto-tagged:\s*unknown)$/i.test(String(entry.notes || "").trim())
);
const byFailureMode = {};
for (const entry of bad) {
  const mode = entry.failureMode || "unclassified";
  byFailureMode[mode] = (byFailureMode[mode] || 0) + 1;
}

const report = {
  total: outcomes.length,
  good: outcomes.filter((entry) => entry.rating === "good").length,
  partial: outcomes.filter((entry) => entry.rating === "partial").length,
  bad: bad.length,
  opaqueBad: opaque.length,
  byFailureMode,
  opaqueAgents: opaque.map((entry) => entry.agentId),
  remediationQueue: opaque.map((entry) => ({
    agentId: entry.agentId,
    requiredEvidence: "recover the original run context or obtain an explicit human disposition",
    nextAction: "do not rewrite the historical outcome; attach evidence or retire it explicitly",
  })),
};
const target = 0.8;
report.qualityTarget = target;
report.goodRate = report.total ? report.good / report.total : 1;
report.targetMet = report.goodRate > target;
report.additionalGoodNeeded = report.targetMet ? 0 : additionalGoodNeeded(report.good, report.total, target);
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--strict") && opaque.length) process.exit(2);
