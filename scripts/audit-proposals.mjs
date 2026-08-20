#!/usr/bin/env node
// Read-only proposal queue audit. It reports stale HIGH work without mutating history.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.ATLAS_PROPOSAL_LOG
  ? path.resolve(process.env.ATLAS_PROPOSAL_LOG)
  : path.join(root, "memory", "proposals.ndjson");
const history = path.join(root, "evidence", "proposal-audit-history.ndjson");
const files = [history, file].filter((candidate) => fs.existsSync(candidate));
const proposalsByKey = new Map();
for (const candidate of files) {
  const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const proposal = JSON.parse(line);
    const key = proposal.id || String(proposal.description || "").normalize("NFKC").trim();
    if (!key) throw new Error(`proposal without identity in ${candidate}`);
    proposalsByKey.set(key, proposal);
  }
}
const proposals = [...proposalsByKey.values()];
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
