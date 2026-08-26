"use strict";
// value_claims.cjs - falsifiable outcome claims attached to fleet builds.
// A claim is born unsettled; it is settled only by an external check after
// merge (kill condition), never by the claimant's self-report. Append-only
// ndjson at memory/value_claims.ndjson. Corrections are dated amendments.
const fs = require("fs");
const path = require("path");

function claimsPath(dir) { return path.join(dir, "value_claims.ndjson"); }

function readClaims(dir) {
  try { return fs.readFileSync(claimsPath(dir), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch (_) { return []; }
}

// claim: { agentId, statement (falsifiable, observable-after-merge),
//          killCondition (how we check + when to abandon), dueDays }
function recordClaim(agentId, statement, killCondition, dir, dueDays) {
  if (!agentId || !statement || !statement.trim() || !killCondition || !killCondition.trim())
    throw new Error("value-claim requires agentId, falsifiable statement, and kill condition");
  const d = typeof dueDays === "number" && dueDays > 0 ? dueDays : 14;
  const rec = {
    ts: new Date().toISOString(),
    agentId: String(agentId),
    statement: String(statement).trim(),
    killCondition: String(killCondition).trim(),
    dueDays: d,
    status: "open",
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(claimsPath(dir), JSON.stringify(rec) + "\n");
  return rec;
}

// settleClaim: verdict must come from evidence text describing what was
// actually observed post-merge. realized=true only when the observable
// state change described in the claim was witnessed.
function settleClaim(agentId, realized, evidence, dir) {
  const claims = readClaims(dir);
  const open = [...claims].reverse().find(c => c.agentId === agentId && c.status === "open");
  if (!open) throw new Error("no open value claim for " + agentId);
  open.settledTs = new Date().toISOString();
  open.status = realized ? "realized" : "unrealized";
  open.evidence = String(evidence || "").trim();
  fs.writeFileSync(claimsPath(dir), claims.map(c => JSON.stringify(c)).join("\n") + "\n");
  return open;
}

// expireOverdue: deterministically persists expiry of overdue open claims.
// A claim past its dueDays with no witnessed settlement is unrealized-by-default;
// silence must become data, not limbo.
function expireOverdue(dir) {
  const claims = readClaims(dir);
  const now = Date.now();
  let changed = 0;
  for (const c of claims) {
    if (c.status === 'open' && now - new Date(c.ts).getTime() > c.dueDays * 864e5) {
      c.status = 'unrealized';
      c.settledTs = new Date().toISOString();
      c.evidence = 'auto: dueDays elapsed with no witnessed settlement (expired)';
      changed++;
    }
  }
  if (changed) fs.writeFileSync(claimsPath(dir), claims.map(c => JSON.stringify(c)).join('\n') + '\n');
  return changed;
}
function valueStats(dir) {
  const claims = readClaims(dir);
  const now = Date.now();
  let open = 0, realized = 0, unrealized = 0;
  for (const c of claims) {
    if (c.status === "open" && now - new Date(c.ts).getTime() > c.dueDays * 864e5) c.status = "expired";
    else if (c.status === "open") open++;
    if (c.status === "realized") realized++;
    else if (c.status === "unrealized") unrealized++;
  }
  const settled = realized + unrealized;
  return { total: claims.length, open, expired: claims.filter(c => c.status === "expired").length,
           realized, unrealized, realizationRate: settled ? Math.round(100 * realized / settled) + "%" : "n/a",
           recent: claims.slice(-5) };
}

module.exports = { recordClaim, settleClaim, readClaims, valueStats, expireOverdue };
