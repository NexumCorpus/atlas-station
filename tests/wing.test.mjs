import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');

const events = [];
const spool = mkdtempSync(path.join(tmpdir(), 'wing-spool-'));
const wing = startWing(path.resolve('wings/echo/wing.json'),
  { spoolDir: spool, onEvent: (e) => events.push(e) });

const waitFor = (pred, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout: ' + JSON.stringify(events))); }
  }, 25);
});

await waitFor(e => e.t === 'status' && e.state === 'ready');          // 1. health: wing announces ready
wing.send({ op: 'echo', payload: 'capstone' });
await waitFor(e => e.t === 'status' && e.echo === 'capstone');        // 2. spool command round-trips
wing.send({ op: 'claim', id: 'c1' });
const claim = await waitFor(e => e.t === 'claim' && e.id === 'c1');
assert.strictEqual(claim.verified, false);                            // 3. claims default UNVERIFIED
wing.send({ op: 'stop' });
await waitFor(e => e.t === 'status' && e.state === 'stopped');        // 4. clean shutdown
wing.stop();
console.log('wing protocol v1: ALL PASS');
process.exit(0);
