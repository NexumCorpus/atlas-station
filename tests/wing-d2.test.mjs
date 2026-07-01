import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');

// Acceptance: the director2-harness wing runs REAL harness commands (offline
// deterministic mock — no API keys needed) and streams protocol events.
process.env.DIRECTOR_HOME = mkdtempSync(path.join(tmpdir(), 'd2-home-'));

const events = [];
const spool = mkdtempSync(path.join(tmpdir(), 'wing-spool-'));
const wing = startWing(path.resolve('wings/director2/wing.json'),
  { spoolDir: spool, onEvent: (e) => events.push(e) });

const waitFor = (pred, ms = 60000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout: ' + JSON.stringify(events.slice(-3)))); }
  }, 50);
});

await waitFor(e => e.t === 'status' && e.state === 'ready');            // 1. health

wing.send({ op: 'exec', cmd: 'init' });                                  // 2. real `director init`
const init = await waitFor(e => e.t === 'status' && e.cmd === 'init' && e.exit !== undefined);
assert.strictEqual(init.exit, 0, 'init failed: ' + init.output);

wing.send({ op: 'exec', cmd: 'new', args: ['wing smoke', '--objective', 'prove the wing mounts'] });
const nw = await waitFor(e => e.t === 'status' && e.cmd === 'new' && e.exit !== undefined);
assert.strictEqual(nw.exit, 0, 'new failed: ' + nw.output);

wing.send({ op: 'exec', cmd: 'status' });                                // 3. real `director status`
const st = await waitFor(e => e.t === 'status' && e.cmd === 'status' && e.exit !== undefined);
assert.strictEqual(st.exit, 0, 'status failed: ' + st.output);
assert.ok(st.output.length > 0, 'status produced no output');

wing.send({ op: 'exec', cmd: 'evolve' });                                // 4. non-whitelisted → refused
const ref = await waitFor(e => e.t === 'need' && e.reason === 'refused');
assert.strictEqual(ref.cmd, 'evolve');

wing.send({ op: 'stop' });                                               // 5. clean shutdown
await waitFor(e => e.t === 'status' && e.state === 'stopped');
wing.stop();
console.log('director2 wing: ALL PASS');
process.exit(0);
