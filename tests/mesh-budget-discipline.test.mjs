// Regression (mesh round-budget exhaustion, runs A-286/A-287/A-288):
// 1) every peer/mesh worker brief must carry the STRICT ROUND BUDGET discipline stamp;
// 2) worker replies over ~4000 chars must be truncated with a "[truncated]" prefix
//    before storage/broadcast so peers do not burn rounds re-reading walls of text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(repo, 'fleethost.mjs'), 'utf8');

// --- 1) Budget stamp present in the brief-construction path ---
const stampIdx = src.indexOf('[STRICT ROUND BUDGET]');
assert.ok(stampIdx > 0, 'budget stamp missing from fleethost.mjs');
for (const fragment of [
  'AT MOST',
  'turns total',
  'Cap every reply under ~200 words',
  'HANDOFF COMPLETE',
]) assert.ok(src.slice(stampIdx - 400, stampIdx + 400).includes(fragment), 'stamp missing fragment: ' + fragment);

// Stamp must be appended to idStamp BEFORE it is composed into the enriched brief.
const composeIdx = src.indexOf('+ idStamp + mailBlock + hierarchyNote');
assert.ok(composeIdx > 0 && composeIdx > stampIdx,
  'budget stamp must be applied to idStamp before brief composition');

// The bound must come from the live turn-bound module (respects build/retry bounds).
assert.match(src.slice(stampIdx - 800, stampIdx), /turnBoundOf\(/, 'stamp bound must use turnBoundOf()');

// --- 2) Output-length guard on terminal replies ---
const guard = src.indexOf("[truncated] ' + final.slice(0, 4000)");
assert.ok(guard > 0, '[truncated] output-length guard missing');
// Guard must run immediately after `final` is assigned, before state persistence.
const finalAssign = src.lastIndexOf('final = String(m.result ?? agents.get(id)?.summary ?? "");', guard);
assert.ok(finalAssign > 0 && guard - finalAssign < 600, 'guard must follow terminal final assignment');
const persist = src.indexOf("summary: final.slice(0, 220), reply: final", guard);
assert.ok(persist > guard, 'guard must run before reply is stored/broadcast');

// --- 3) Behavioral simulation of the truncation logic ---
function applyGuard(raw) {
  let final = String(raw);
  try { if (final.length > 4000) { final = '[truncated] ' + final.slice(0, 4000); } } catch {}
  return final;
}
const short = applyGuard('short result');
assert.equal(short, 'short result', 'short replies pass through untouched');
const wall = 'x'.repeat(9000);
const cut = applyGuard(wall);
assert.equal(cut.length, 4012, 'over-long reply = [truncated] (12 chars) + 4000');
assert.ok(cut.startsWith('[truncated] '), 'truncation marker prepended');

console.log('mesh-budget-discipline.test.mjs: ALL PASS');

