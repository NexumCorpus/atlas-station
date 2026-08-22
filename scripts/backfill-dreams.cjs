#!/usr/bin/env node
'use strict';
// One-shot repair for stubbed dream reflections. For each stub row in
// memory/dreams.ndjson (mood "processing", empty arrays), find the matching
// done receipt in memory/dream-receipts.ndjson and re-parse its raw output
// with the validated parser. Repairs rows in place with backfill metadata;
// never touches rows it cannot repair. --dry reports without writing.
const fs = require("fs");
const path = require("path");
const dream = require(path.join(__dirname, "..", "dream.cjs"));
const REPO = path.join(__dirname, "..");
const memDir = path.join(REPO, "memory");
const dry = process.argv.includes("--dry");
const dreamsPath = path.join(memDir, "dreams.ndjson");
const receiptsPath = path.join(memDir, "dream-receipts.ndjson");
const load = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const dreams = load(dreamsPath);
const receipts = load(receiptsPath);
// Best done output per pulseCount.
const doneByPulse = new Map();
for (const r of receipts) {
  if (r.state !== "done" || !r.output || String(r.output).length < 50) continue;
  if (r.pulseCount == null) continue;
  if (!doneByPulse.has(r.pulseCount)) doneByPulse.set(r.pulseCount, r);
}
const isStub = (d) => d && d.mood === "processing" && (!d.patterns || !d.patterns.length) && (!d.insights || !d.insights.length) && (!d.proposals || !d.proposals.length);
let repaired = 0, unrecoverable = 0;
const out = dreams.map((d) => {
  if (!isStub(d)) return d;
  // Stub rows carry only ts - match receipts by nearest pulse via ts ordering.
  const candidates = [...doneByPulse.entries()]
    .map(([pulse, r]) => ({ pulse, r, delta: Math.abs(new Date(r.ts).getTime() - new Date(d.ts).getTime()) }))
    .sort((a, b) => a.delta - b.delta);
  const best = candidates[0];
  if (!best || best.delta > 30 * 60 * 1000) { unrecoverable++; return d; }
  const parsed = dream.parseDreamReport(best.r.output);
  if (!parsed.ok) { unrecoverable++; return d; }
  repaired++;
  return { ...d, ...parsed.report, backfilled: true, backfilledFrom: best.r.dreamId || null, backfilledTs: new Date().toISOString() };
});
console.log("stubs repaired:", repaired, "| unrecoverable:", unrecoverable, "| dry:", dry);
if (!dry && repaired > 0) {
  fs.writeFileSync(dreamsPath + ".tmp", out.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
  fs.renameSync(dreamsPath + ".tmp", dreamsPath);
  console.log("dreams.ndjson rewritten");
}