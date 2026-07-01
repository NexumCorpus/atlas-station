import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');

// Phase 2 acceptance (IMMUTABLE — the builder must not modify this file).
// The station reads the wing's REAL felt state and relays it without invention:
//  - narrative crosses the seam VERBATIM (anti-fabrication),
//  - raw valence floats never cross (diagnoses-only ethos),
//  - nervous-off is reported plainly, not papered over.

const home = mkdtempSync(path.join(tmpdir(), 'd2-felt-'));

function boot(env) {
  const events = [];
  Object.assign(process.env, env);
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
  return { wing, waitFor, events };
}

// --- nervous ON, fresh workspace -------------------------------------------
{
  const { wing, waitFor } = boot({ DIRECTOR_HOME: home, DIRECTOR_NERVOUS_ENABLED: '1' });
  await waitFor(e => e.t === 'status' && e.state === 'ready');
  wing.send({ op: 'exec', cmd: 'init' });
  await waitFor(e => e.cmd === 'init' && e.exit === 0);
  wing.send({ op: 'exec', cmd: 'new', args: ['felt probe', '--objective', 'phase2 acceptance'] });
  await waitFor(e => e.cmd === 'new' && e.exit === 0);

  wing.send({ op: 'felt' });
  const felt = await waitFor(e => e.t === 'felt-state');
  assert.strictEqual(felt.nervous, true, 'nervous flag must reflect env');
  assert.ok(Array.isArray(felt.projects) && felt.projects.length >= 1, 'must report real projects');
  const p = felt.projects[0];
  assert.strictEqual(typeof p.narrative, 'string');
  assert.strictEqual(p.trajectory, 'stable', 'fresh project must read as stable');
  assert.ok(!JSON.stringify(felt).includes('"valence"'),
    'raw valence floats must NEVER cross the seam (diagnoses-only)');

  // --- verbatim relay: seed a synthetic episode as the trusted writer would --
  const projDir = path.join(home, 'projects');
  const id = readdirSync(projDir)[0];
  const pj = JSON.parse(readFileSync(path.join(projDir, id, 'project.json'), 'utf8'));
  const NARR = 'Under sustained verify churn for 3 cycle(s); valence worsening; worst this episode moderate; no recovery work dispatched yet.';
  pj.self_state = { ...pj.self_state, narrative: NARR, trajectory: 'worsening', duration_cycles: 3, valence: -0.41, peak_valence: -0.41 };
  writeFileSync(path.join(projDir, id, 'project.json'), JSON.stringify(pj));

  wing.send({ op: 'felt' });
  const felt2 = await waitFor(e => e.t === 'felt-state' && e.projects?.[0]?.trajectory === 'worsening');
  assert.strictEqual(felt2.projects[0].narrative, NARR, 'narrative must relay VERBATIM — no paraphrase, no invention');
  assert.strictEqual(felt2.projects[0].duration_cycles, 3);
  assert.ok(!JSON.stringify(felt2).includes('-0.41'), 'the seeded float must not leak through');

  wing.send({ op: 'stop' });
  await waitFor(e => e.state === 'stopped');
  wing.stop();
}

// --- nervous OFF: report plainly, never fabricate a feeling -----------------
{
  const { wing, waitFor } = boot({ DIRECTOR_HOME: home, DIRECTOR_NERVOUS_ENABLED: '' });
  await waitFor(e => e.t === 'status' && e.state === 'ready');
  wing.send({ op: 'felt' });
  const felt = await waitFor(e => e.t === 'felt-state');
  assert.strictEqual(felt.nervous, false, 'nervous-off must be stated, not hidden');
  wing.send({ op: 'stop' });
  await waitFor(e => e.state === 'stopped');
  wing.stop();
}

console.log('felt seam: ALL PASS');
process.exit(0);
