// One-shot IPC dispatcher: boots fleethost.mjs as a supervised child, waits for
// warmup, sends {t:"dispatch"} per main.cjs protocol, streams agent events,
// exits when the target agent reaches a terminal state. Detached-safe.
import { fork } from 'node:child_process';
const FLEETHOST = 'E:\\atlas-station\\fleehost.mjs'.replace('fleehost', 'fleethost');
const TASK = process.env.TAP_TASK;
const ID = process.env.TAP_ID || 'B-reflex';
if (!TASK) { console.error('TAP_TASK required'); process.exit(2); }
const child = fork(FLEETHOST, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
let dispatched = false;
let sawAgent = false;
const arm = setTimeout(() => {
  console.log('[dispatch] sending', ID);
  child.send({ t: 'dispatch', id: ID, task: TASK, mode: 'build' });
  dispatched = true;
}, 9000);
const watchdog = setTimeout(() => {
  console.log('[dispatch] timeout 25min, detaching (agent keeps running under fleethost)');
  try { child.disconnect(); } catch {}
  process.exit(3);
}, 25 * 60 * 1000);
child.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'agent' && m.id === ID) {
    sawAgent = true;
    const tag = m.partial ? 'partial' : m.state;
    console.log(`[agent ${tag}]`, String(m.summary || m.lastTool || '').slice(0, 200));
    if (!m.partial && ['done', 'failed', 'cancelled'].includes(m.state)) {
      clearTimeout(watchdog);
      console.log('[dispatch] TERMINAL:', m.state);
      setTimeout(() => { try { child.disconnect(); } catch {} process.exit(m.state === 'done' ? 0 : 1); }, 1500);
    }
  }
});
child.on('exit', (code) => {
  clearTimeout(arm); clearTimeout(watchdog);
  console.log('[dispatch] fleethost exited code=', code, 'dispatched=', dispatched, 'sawAgent=', sawAgent);
  process.exit(dispatched && !sawAgent ? 4 : code || 0);
});
