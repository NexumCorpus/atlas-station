#!/usr/bin/env node
// Read-only proposal queue audit. It reports stale HIGH work without mutating history.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "memory", "proposals.ndjson");
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
const proposals = lines.map((line) => JSON.parse(line));
const high = proposals.filter((p) => String(p.priority).toLowerCase() === "high");
const pendingHigh = high.filter((p) => p.state === "pending");
const incompleteDeferrals = high.filter((p) =>
  p.state === "deferred" && (!String(p.nextAction || "").trim() || !String(p.retryCondition || "").trim())
);

const report = {
  total: proposals.length,
  high: high.length,
  pendingHigh: pendingHigh.map((p) => p.id || p.description),
  incompleteDeferrals: incompleteDeferrals.map((p) => ({
    id: p.id || null,
    description: p.description,
    missing: [
      !String(p.nextAction || "").trim() ? "nextAction" : null,
      !String(p.retryCondition || "").trim() ? "retryCondition" : null,
    ].filter(Boolean),
  })),
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--strict") && (pendingHigh.length || incompleteDeferrals.length)) process.exit(2);
