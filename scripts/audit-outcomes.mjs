#!/usr/bin/env node
// Read-only build-outcome quality audit. Historical records are never rewritten.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { additionalGoodNeeded } from "./quality-metrics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const memDir = path.resolve(args.find((arg) => arg !== "--strict") || path.join(root, "memory"));
const file = path.join(memDir, "outcomes.ndjson");
const dispositionFile = path.join(memDir, "outcome-dispositions.ndjson");
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
const outcomes = lines.map((line) => JSON.parse(line));
const dispositions = fs.existsSync(dispositionFile)
  ? fs.readFileSync(dispositionFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const digest = (value) => `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
let previousHash = null;
const dispositionErrors = [];
dispositions.forEach((record, index) => {
  const { hash, ...body } = record;
  if (body.seq !== index + 1) dispositionErrors.push({ index, reason: "sequence" });
  if (body.previousHash !== previousHash) dispositionErrors.push({ index, reason: "previousHash" });
  if (digest(body) !== hash) dispositionErrors.push({ index, reason: "hash" });
  previousHash = hash;
});
const validDisposition = new Map();
if (dispositionErrors.length === 0) {
  for (const disposition of dispositions) validDisposition.set(disposition.agentId, disposition);
}
const bad = outcomes.filter((entry) => entry.rating === "bad");
const isOpaque = (entry) =>
  entry.failureMode === "unknown" || /^(unknown|auto-tagged:\s*unknown)$/i.test(String(entry.notes || "").trim());
const dispositionFor = (entry) => {
  const disposition = validDisposition.get(entry.agentId);
  return disposition
    && disposition.originalHash === digest(entry)
    && disposition.originalRating === entry.rating
    && ["retired", "superseded"].includes(disposition.disposition)
    && Array.isArray(disposition.evidence)
    && disposition.evidence.length
    ? disposition : null;
};
const opaque = bad.filter((entry) => isOpaque(entry) && !dispositionFor(entry));
const resolvedOpaque = bad.filter((entry) => isOpaque(entry) && dispositionFor(entry));
const byFailureMode = {};
for (const entry of bad) {
  const disposition = dispositionFor(entry);
  const mode = disposition ? `${disposition.disposition}:${entry.failureMode || "unclassified"}` : (entry.failureMode || "unclassified");
  byFailureMode[mode] = (byFailureMode[mode] || 0) + 1;
}

const report = {
  total: outcomes.length,
  good: outcomes.filter((entry) => entry.rating === "good").length,
  partial: outcomes.filter((entry) => entry.rating === "partial").length,
  bad: bad.length,
  opaqueBad: opaque.length,
  resolvedOpaqueBad: resolvedOpaque.length,
  dispositionLedger: {
    total: dispositions.length,
    valid: dispositionErrors.length === 0,
    errors: dispositionErrors,
    head: previousHash,
  },
  byFailureMode,
  opaqueAgents: opaque.map((entry) => entry.agentId),
  resolvedOpaqueAgents: resolvedOpaque.map((entry) => ({
    agentId: entry.agentId,
    disposition: dispositionFor(entry).disposition,
    evidence: dispositionFor(entry).evidence,
  })),
  remediationQueue: opaque.map((entry) => ({
    agentId: entry.agentId,
    requiredEvidence: "recover the original run context or obtain an explicit human disposition",
    nextAction: "do not rewrite the historical outcome; attach evidence or retire it explicitly",
  })),
};
const target = 0.8;
report.qualityTarget = target;
report.goodRate = report.total ? report.good / report.total : 1;
report.targetMet = report.goodRate >= target;
report.additionalGoodNeeded = report.targetMet ? 0 : additionalGoodNeeded(report.good, report.total, target);
console.log(JSON.stringify(report, null, 2));
if (strict && (opaque.length || dispositionErrors.length || !report.targetMet)) process.exit(2);
