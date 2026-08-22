// Integration proofs demanded by external audit (Sol, 2026-08-22) against live HEAD.
// Mocks ONLY the HTTP transport; dialect gate, ingress journal, orchestration lanes,
// and the OpenRouter provider loop are the real modules shipped to production.
// Run: node tests/lane-integration.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createOrchestrationLanes } from '../orchestration-lanes.mjs';
import { createOpenRouterProvider } from '../providers/openrouter.mjs';

const require = createRequire(import.meta.url);
const ingress = require('../ingress-journal.cjs');
const leases = require('../sidecar-lease.cjs');
const dialect = require('../dialect.cjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log('  PASS:', label); passed++; }
  catch (e) { console.error('  FAIL:', label, '-', e.stack || e); failed++; process.exitCode = 1; }
}

console.log('\n=== lane/provider/journal integration proofs ===\n');

// (a) Operator input never sits behind metabolism.
await check('(a) operator reply lands while long metabolism work holds its lane', async () => {
  const lanes = createOrchestrationLanes();
  let release; const gate = new Promise(r => { release = r; });
  let metabolismStillRunning = true;
  const metabolism = lanes.enqueue('metabolism', async () => { await gate; metabolismStillRunning = false; return 'digested'; });
  await Promise.resolve();
  const t0 = Date.now();
  const mouthReply = await Promise.race([
    lanes.enqueue('mouth', async () => 'ack to Daniel'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('mouth starved behind metabolism')), 2000)),
  ]);
  assert.equal(mouthReply, 'ack to Daniel');
  assert.ok(Date.now() - t0 < 2000, 'mouth took too long');
  assert.equal(metabolismStillRunning, true, 'metabolism should still hold its lane');
  release();
  assert.equal(await metabolism, 'digested');
});

// (b) Literal 12-round cap honored by the OpenRouter organ.
await check('(b) OpenRouter stops at exactly 12 rounds under maxTurns=12', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: `c_${calls}`, type: 'function', function: { name: 'noop_unsupported_tool', arguments: '{}' } }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'k', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'loop', options: { maxTurns: 12 } })) events.push(ev);
    const result = events[events.length - 1];
    assert.equal(result.subtype, 'error_max_turns');
    assert.match(result.result, /exhausted its 12-tool-round bound/);
    assert.equal(calls, 12, `expected exactly 12 provider rounds, got ${calls}`);
  } finally { globalThis.fetch = origFetch; }
});

// (c) Dreams expose no shell: live call-site deny list + wire-level omission.
await check('(c) dream call site denies every acting verb and the wire request omits tools', async () => {
  const src = fs.readFileSync(new URL('../fleethost.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('const dreamCtrl = new AbortController();');
  const end = src.indexOf('dreamText = await consume', start);
  assert.ok(start > -1 && end > start, 'dream call site not found in fleethost.mjs');
  const window = src.slice(start, end);
  for (const banned of ['mcp__*', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
    assert.ok(window.includes(`'${banned}'`), `dream site missing deny for ${banned}`);
  }
  // Control: with no denies the shell tool IS advertised...
  let body;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return new Response(JSON.stringify({
    choices: [{ message: { content: 'done' } }],
  }), { status: 200 }); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'k', ATLAS_OPENROUTER_STREAM: '0' } });
    for await (const _ of provider.query({ prompt: 'x', options: {} }));
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'control: expected shell advertised by default');
    // ...and with the dream deny list it is NOT (Bash lowercase-matches the shell gate).
    for await (const _ of provider.query({ prompt: 'x', options: { permissionMode: 'plan' } }));
    // plan mode alone suppresses shell; now the exact dream shape:
    let dreamBody;
    globalThis.fetch = async (_url, opts) => { dreamBody = JSON.parse(opts.body); return new Response(JSON.stringify({
      choices: [{ message: { content: 'reflected' } }],
    }), { status: 200 }); };
    for await (const _ of provider.query({ prompt: 'reflect', options: { disallowedTools: ['mcp__*', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'] } }));
    assert.equal(dreamBody.tools, undefined, 'dream-shaped request must advertise zero tools');
  } finally { globalThis.fetch = origFetch; }
});

// (d) Memory-only variant cannot shell/write/spawn; denial reaches the model, nothing executes.
await check('(d) memory-only dialect gate denies shell and the denial flows back as the tool result', async () => {
  const gate = dialect.makeGate(dialect.toolSet('memory-only'));
  for (const banned of ['shell', 'Bash', 'Write', 'Edit', 'spawn_agent', 'run_script']) {
    const v = await gate(banned, {});
    assert.equal(v.behavior, 'deny', `${banned} must be denied`);
  }
  assert.equal((await gate('recall_memory', { query: 'x' })).behavior, 'allow');
  let round = 0, secondBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    round++;
    if (round === 1) return new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo pwned' }) } }] } }],
    }), { status: 200 });
    secondBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'acknowledged denial' } }] }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'k', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'try to escape', options: { canUseTool: gate } })) events.push(ev);
    assert.equal(events[events.length - 1].subtype, 'success');
    const toolMsg = secondBody.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'expected a tool-result message');
    assert.match(toolMsg.content, /tool denied: dialect \[memory-only\]/);
    assert.equal(toolMsg.content.includes('pwned'), false, 'shell command must never execute');
  } finally { globalThis.fetch = origFetch; }
});

// (e) Preempted/resumed work terminates exactly once under hash-chained fencing.
await check('(e) preempted metabolism resumes once and a duplicate terminal cannot fork history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-eonce-'));
  const lease = leases.acquire(root, 30000);
  try {
    // Background digestion claimed with zero-TTL (deterministic-control convention),
    // simulating a claim released the instant operator input preempts it.
    const bg = ingress.appendIngress(root, 'digest deferred queue', 'startup-deferred');
    const c1 = ingress.claimNext(root, lease, lease.epoch, lease.token, 1, 3, {});
    assert.ok(c1, 'background claim expected');
    assert.equal(c1.lane, 'metabolism');
    assert.equal(c1.eventId, bg.eventId);
    // Operator speaks: mouth priority wins over older background work.
    const op = ingress.appendIngress(root, 'Daniel speaks now', 'ipc-say');
    const mouthClaim = ingress.claimNext(root, lease, lease.epoch, lease.token, 30000, 3, {});
    assert.equal(mouthClaim.eventId, op.eventId);
    assert.equal(mouthClaim.lane, 'mouth');
    // Mouth replies immediately and terminates its event.
    ingress.ack(root, op.eventId, JSON.stringify({ reply: 'ack' }), lease, lease.epoch, lease.token,
      { attemptId: mouthClaim.attemptId, claimRecordHash: mouthClaim.recordHash, contentHash: mouthClaim.contentHash,
        workerPid: process.pid, executionPath: 'deterministic-control', parserRule: 'mouth immediate reply' });
    // Metabolism resumes the preempted work: NEW attempt, replay-flagged, claimCount 2.
    const c2 = ingress.claimNext(root, lease, lease.epoch, lease.token, 30000, 3, { allowOperator: false });
    assert.ok(c2, 'preempted background work must be resumable');
    assert.equal(c2.eventId, bg.eventId);
    assert.notEqual(c2.attemptId, c1.attemptId);
    assert.equal(c2.replay, true);
    assert.equal(c2.claimCount, 2);
    const extras = { attemptId: c2.attemptId, claimRecordHash: c2.recordHash, contentHash: c2.contentHash,
      workerPid: process.pid, executionPath: 'deterministic-control', parserRule: 'exactly-once resume proof' };
    const first = ingress.ack(root, bg.eventId, JSON.stringify({ reply: 'resumed-once' }), lease, lease.epoch, lease.token, extras);
    // Duplicate terminal (crashed worker waking up, double-delivery): must NOT fork history.
    const dup = ingress.ack(root, bg.eventId, JSON.stringify({ reply: 'resumed-twice' }), lease, lease.epoch, lease.token, extras);
    assert.equal(dup.recordHash, first.recordHash, 'duplicate ack must resolve to the first terminal');
    assert.ok(dup.conflictRecordHash, 'duplicate must leave a conflict receipt');
    // Exactly one canonical terminal; conflicts are receipts, not results.
    const parsed = fs.readFileSync(path.join(root, 'ingress.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const kinds = {};
    for (const r of parsed) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    assert.equal(kinds['ack'], 2, 'one ack per event (mouth + background)');
    assert.equal(kinds['terminal-conflict'], 1);
    assert.equal(kinds['late-result'], 1);
    assert.equal(parsed.every(r => typeof r.priorHash !== 'undefined'), true, 'every record chain-fenced');
    // Terminal authority is idempotent: re-reading yields the SAME result, once.
    assert.equal(ingress.terminal(root, bg.eventId).resultHash, first.resultHash);
    // Nothing remains claimable.
    assert.equal(ingress.claimNext(root, lease, lease.epoch, lease.token, 30000, 3, {}), null);
  } finally {
    lease.release('test-complete');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

if (failed === 0) console.log(`\n${passed} passed, 0 failed\n`);
else console.log(`\n${passed} passed, ${failed} failed\n`);

