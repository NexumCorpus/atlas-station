import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');
const { certifyClaim } = require('../grader.cjs');

// Phase 5 acceptance (IMMUTABLE — the builder must not modify this file).
// First mission, end to end: the station dispatches a real discovery campaign
// (offline deterministic mock backend), receives a claim born UNVERIFIED with
// a real audit bundle, and the grader gate earns — or refuses — certification
// by running the domain's TRUSTED oracle on station-chosen holdout seeds.
// A tampered artifact must flip the same claim to rejected: the gate exercises
// the artifact itself, not the paperwork.

process.env.DIRECTOR_HOME = mkdtempSync(path.join(tmpdir(), 'd2-mission-'));

const events = [];
const spool = mkdtempSync(path.join(tmpdir(), 'wing-spool-'));
const wing = startWing(path.resolve('wings/director2/wing.json'),
  { spoolDir: spool, onEvent: (e) => events.push(e) });

const waitFor = (pred, ms = 300000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout: ' + JSON.stringify(events.slice(-3)))); }
  }, 100);
});

await waitFor(e => e.t === 'status' && e.state === 'ready');
wing.send({ op: 'exec', cmd: 'init' });
await waitFor(e => e.cmd === 'init' && e.exit === 0);

// --- dispatch the campaign ---------------------------------------------------
wing.send({ op: 'mission', domain: 'topk' });
const claim = await waitFor(e => e.t === 'claim');

// Born unverified — the host default no wing can override.
assert.strictEqual(claim.verified, false, 'claims are born unverified');
assert.ok(claim.bundle, 'mission claim must carry an audit bundle path');
assert.ok(existsSync(path.join(claim.bundle, 'claim.json')), 'bundle: claim.json');
assert.ok(existsSync(path.join(claim.bundle, 'best_solution.py')), 'bundle: the artifact itself');

// Statement honesty: the deterministic mock campaign declares verdict
// "matches" — the claim must carry that verdict and must not inflate it.
assert.ok(/matches/.test(claim.statement), 'statement must carry the declared verdict: ' + claim.statement);
assert.ok(!/beats/.test(claim.statement), 'a matches-verdict must never be inflated to beats');

// --- the gate earns certification on the REAL artifact ------------------------
const HOLDOUT = [101, 202];
const certified = await certifyClaim(claim, { holdoutSeeds: HOLDOUT });
assert.strictEqual(certified.verified, true,
  'genuine campaign artifact must certify: ' + (certified.rejection || ''));

// --- tamper with the artifact: the same claim must now be REFUSED -------------
const artifact = path.join(claim.bundle, 'best_solution.py');
const original = readFileSync(artifact, 'utf8');
writeFileSync(artifact, 'def solve(items, k):\n    return list(items)[:k]\n');
const tampered = await certifyClaim(claim, { holdoutSeeds: HOLDOUT });
assert.strictEqual(tampered.verified, false, 'tampered artifact must be rejected');
assert.ok(/reproduc|holdout/i.test(tampered.rejection || ''),
  'rejection must name the failing stage: ' + tampered.rejection);
writeFileSync(artifact, original);

wing.send({ op: 'stop' });
await waitFor(e => e.state === 'stopped');
wing.stop();
console.log('first mission: ALL PASS');
process.exit(0);
