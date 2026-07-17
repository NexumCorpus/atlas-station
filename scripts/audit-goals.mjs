import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const strict = process.argv.includes('--strict');
const memDir = args.find(arg => arg !== '--strict') || path.join(process.cwd(), 'memory');
function readNdjson(name) {
  try { return fs.readFileSync(path.join(memDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(Boolean); }
  catch { return []; }
}
const goals = readNdjson('goals.ndjson');
const outcomes = readNdjson('outcomes.ndjson');
const proposals = readNdjson('proposals.ndjson');
const good = outcomes.filter(o => o.rating === 'good').length;
const qualityTarget = 0.8;
const goodRate = outcomes.length ? good / outcomes.length : 0;
let additionalGoodNeeded = 0;
while (outcomes.length + additionalGoodNeeded < 10000 && (good + additionalGoodNeeded) / (outcomes.length + additionalGoodNeeded) <= qualityTarget) additionalGoodNeeded++;
const pendingHigh = proposals.filter(p => p.priority === 'high' && p.state === 'pending').length;
const checks = goals.map(goal => {
  let evidenceMet = null;
  if (goal.area === 'quality') evidenceMet = goodRate > qualityTarget;
  if (goal.area === 'discipline') evidenceMet = pendingHigh === 0;
  return { id: goal.id, state: goal.state, evidenceMet, stateMatchesEvidence: evidenceMet === null ? null : (goal.state === 'done') === evidenceMet };
});
const report = { memDir, quality: { total: outcomes.length, good, goodRate, target: qualityTarget, targetMet: goodRate > qualityTarget, additionalGoodNeeded }, proposals: { pendingHigh }, goals: checks, consistent: checks.every(check => check.stateMatchesEvidence !== false) };
console.log(JSON.stringify(report, null, 2));
if (strict && !report.consistent) process.exitCode = 2;
