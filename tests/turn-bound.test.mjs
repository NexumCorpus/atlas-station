// Unit tests: worker turn-bound class fix (DREAM-408 / B-155 starvation class).
// Run: node tests/turn-bound.test.mjs
import assert from 'node:assert';
import { workerTurnBound, WORKER_TURN_BOUND } from '../providers/turn-bound.mjs';
import { createOpenRouterProvider } from '../providers/openrouter.mjs';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log('  PASS:', label); passed++; }
  catch (e) { console.error('  FAIL:', label, '-', e.message); failed++; }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log('  PASS:', label); passed++; }
  catch (e) { console.error('  FAIL:', label, '-', e.message); failed++; }
}

console.log('\n=== turn-bound class-fix tests ===\n');

check('workerTurnBound defaults to WORKER_TURN_BOUND', () => {
  assert.strictEqual(workerTurnBound(undefined), WORKER_TURN_BOUND);
  assert.strictEqual(workerTurnBound({}), WORKER_TURN_BOUND);
});
check('explicit maxTurns wins (call site owns its bound)', () => {
  assert.strictEqual(workerTurnBound({ maxTurns: 12 }), null);
  assert.strictEqual(workerTurnBound({ maxTurns: 40 }), null);
});
check('orchestrator seat exempt', () => {
  assert.strictEqual(workerTurnBound({ atlasMode: 'orchestrator' }), null);
});

function toolCallRound(n) {
  return {
    choices: [{ message: { content: null, tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'noop_unsupported_tool', arguments: '{}' } }] } }],
  };
}

await checkAsync(`provider honors maxTurns=3: exhausts at 3 rounds with error_max_turns`, async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(toolCallRound(calls)), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'loop forever', options: { maxTurns: 3 } })) events.push(ev);
    const result = events[events.length - 1];
    assert.strictEqual(result.type, 'result');
    assert.strictEqual(result.subtype, 'error_max_turns', `subtype was ${result.subtype}`);
    assert.match(result.result, /exhausted its 3-tool-round bound/);
    assert.strictEqual(calls, 3, `expected exactly 3 provider rounds, got ${calls}`);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('uncapped run still dies at the hard 24-round provider ceiling, classified as exhaustion', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(toolCallRound(calls)), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'loop forever', options: {} })) events.push(ev);
    const result = events[events.length - 1];
    // Any round-cap exit is exhaustion, regardless of whose bound: caller cap or
    // provider ceiling. Bare "error" stays reserved for request/provider failures.
    assert.strictEqual(result.subtype, 'error_max_turns', `ceiling death misclassified: ${result.subtype}`);
    assert.match(result.result, /exhausted its 24-tool-round bound \(provider ceiling 24\)/);
    assert.strictEqual(calls, 24);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('request failure keeps bare error subtype (not exhaustion)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'x', options: {} })) events.push(ev);
    const result = events[events.length - 1];
    assert.strictEqual(result.subtype, 'error');
    assert.match(String(result.result), /connection refused/);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('success path unaffected by the bound', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; const msg = calls < 2 ? toolCallRound(calls) : { choices: [{ message: { content: 'done answering' } }] }; return new Response(JSON.stringify(msg), { status: 200 }); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const ev of provider.query({ prompt: 'finish quickly', options: {} })) events.push(ev);
    const result = events[events.length - 1];
    assert.strictEqual(result.subtype, 'success');
    assert.strictEqual(result.result, 'done answering');
    assert.strictEqual(calls, 2);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('disallowed shell is omitted from the OpenRouter request', async () => {
  let requestBody;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'policy held' } }] }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    for await (const _ of provider.query({ prompt: 'inspect only', options: { disallowedTools: ['shell'] } })) {}
    assert.equal(requestBody.tools, undefined);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('canUseTool denial is returned to the model without executing shell', async () => {
  let calls = 0;
  let secondBody;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'denied_1', type: 'function', function: { name: 'shell', arguments: '{"command":"throw should-not-run"}' } }] } }] }), { status: 200 });
    secondBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'denial observed' } }] }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    for await (const _ of provider.query({ prompt: 'attempt denied action', options: { canUseTool: async () => ({ behavior: 'deny', message: 'test policy' }) } })) {}
    const toolResult = secondBody.messages.find(message => message.role === 'tool');
    assert.match(toolResult.content, /tool denied: test policy/);
  } finally { globalThis.fetch = origFetch; }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
