// Station mission driver: dispatch a discovery campaign through the director2
// wing and put its claim through the grader gate. The claim is born unverified;
// only the gate can change that. Usage:
//   node scripts/mission-run.mjs <domain> [holdoutSeed ...]
// Backend follows the environment (DIRECTOR_BACKEND=claude_cli for live runs).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');
const { certifyClaim } = require('../grader.cjs');

const domain = process.argv[2] || 'topk';
const holdoutSeeds = process.argv.slice(3).map(Number);
if (!holdoutSeeds.length) holdoutSeeds.push(101, 202);

const events = [];
const spool = mkdtempSync(path.join(tmpdir(), 'wing-spool-'));
const wing = startWing(path.resolve(import.meta.dirname, '../wings/director2/wing.json'),
  { spoolDir: spool, onEvent: (e) => { events.push(e); console.log('[wing]', JSON.stringify(e).slice(0, 300)); } });

const waitFor = (pred, ms) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout waiting for ' + pred)); }
  }, 200);
});

await waitFor(e => e.t === 'status' && e.state === 'ready', 30000);
wing.send({ op: 'exec', cmd: 'init' });
await waitFor(e => e.cmd === 'init' && e.exit !== undefined, 120000);

console.log(`[mission] dispatching domain=${domain} backend=${process.env.DIRECTOR_BACKEND || 'auto'} holdout=[${holdoutSeeds}]`);
wing.send({ op: 'mission', domain });
const claim = await waitFor(e => e.t === 'claim' || e.reason === 'mission-failed',
  Number(process.env.WING_MISSION_TIMEOUT_S || 600) * 1000 + 60000);

if (claim.t !== 'claim') {
  console.log('[mission] FAILED:', claim.detail);
  wing.send({ op: 'stop' }); wing.stop(); process.exit(1);
}
console.log('[mission] claim (born unverified):', claim.statement);
const verdict = await certifyClaim(claim, { holdoutSeeds });
console.log('[gate]', verdict.verified ? 'CERTIFIED' : 'REJECTED',
  '—', verdict.certification || verdict.rejection);
wing.send({ op: 'stop' });
await waitFor(e => e.state === 'stopped', 15000).catch(() => {});
wing.stop();
process.exit(verdict.verified ? 0 : 2);
