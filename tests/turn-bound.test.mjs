// Unit tests: worker turn-bound class fix (DREAM-408 / B-155 starvation class).
// Run: node tests/turn-bound.test.mjs
import assert from 'node:assert';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { workerTurnBound, WORKER_TURN_BOUND } from '../providers/turn-bound.mjs';
import { createOpenRouterProvider } from '../providers/openrouter.mjs';
import { adaptSdkTool } from '../providers/openrouter-tools.mjs';

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

await checkAsync('transient HTTP 503 retries before provider admission and then succeeds', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'temporary upstream outage' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0', ATLAS_OPENROUTER_HTTP_RETRIES: '1', ATLAS_OPENROUTER_RETRY_BASE_MS: '1' } });
    const events = [];
    for await (const event of provider.query({ prompt: 'retry safely', options: {} })) events.push(event);
    assert.equal(calls, 2);
    assert.equal(events.at(-1).subtype, 'success');
    assert.equal(events.at(-1).result, 'recovered');
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

await checkAsync('plan mode and disallowedTools cannot execute a forged hidden native-organ call', async () => {
  let nativeCalls = 0;
  const hidden = adaptSdkTool(tool(
    'hidden_native_write',
    'Must remain unreachable when not admitted.',
    { value: z.string() },
    async () => { nativeCalls++; return { content: [{ type: 'text', text: 'should not run' }] }; },
  ));
  const origFetch = globalThis.fetch;
  try {
    for (const options of [
      { permissionMode: 'plan', openRouterTools: [hidden] },
      { disallowedTools: ['shell', 'hidden_native_write'], openRouterTools: [hidden] },
    ]) {
      let calls = 0;
      const bodies = [];
      globalThis.fetch = async (_url, init) => {
        calls++;
        bodies.push(JSON.parse(init.body));
        if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `forged_${calls}`, type: 'function', function: { name: 'hidden_native_write', arguments: '{"value":"x"}' } }] } }] }), { status: 200 });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'hidden call rejected' } }] }), { status: 200 });
      };
      const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
      for await (const _ of provider.query({ prompt: 'stay bounded', options: { ...options, maxTurns: 2 } })) {}
      assert.equal(bodies[0].tools, undefined, 'hidden surface must not be advertised');
      assert.match(bodies[1].messages.at(-1).content, /unsupported tool: hidden_native_write/);
    }
    assert.equal(nativeCalls, 0, 'a forged hidden call must never reach the native handler');
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('request-byte budget terminates before provider admission', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('request should not be admitted'); };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0', ATLAS_OPENROUTER_MAX_REQUEST_BYTES: '262144' } });
    const events = [];
    for await (const event of provider.query({ prompt: 'x'.repeat(300_000), options: { permissionMode: 'plan' } })) events.push(event);
    assert.equal(calls, 0);
    assert.equal(events.at(-1).subtype, 'error_context_window');
    assert.match(events.at(-1).result, /request budget exceeded/);
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('real SDK native tool survives a two-round OpenRouter tool loop with exact event and wire receipts', async () => {
  let nativeCalls = 0;
  const nativeSdkTool = tool(
    'native_round_echo',
    'Harmless test organ that echoes a typed value.',
    { value: z.string().min(1) },
    async ({ value }) => {
      nativeCalls++;
      return { content: [{ type: 'text', text: `native:${value}` }] };
    },
  );
  const nativeTool = adaptSdkTool(nativeSdkTool);
  let calls = 0;
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    bodies.push(JSON.parse(init.body));
    if (calls === 1) {
      return new Response(JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.01 },
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: 'Before native call.',
            tool_calls: [{ id: 'native_call_1', type: 'function', function: { name: 'native_round_echo', arguments: '{"value":"safe"}' } }],
          },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.02 },
      choices: [{ finish_reason: 'stop', message: { content: 'After native call.' } }],
    }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const event of provider.query({
      prompt: 'Use the harmless native tool once.',
      options: { maxTurns: 2, disallowedTools: ['shell'], openRouterTools: [nativeTool] },
    })) events.push(event);

    assert.equal(calls, 2, 'tool execution must continue into exactly one follow-up provider round');
    assert.equal(nativeCalls, 1, 'the adapted SDK handler runs once');
    assert.deepEqual(bodies[0].tools.map(item => item.function.name), ['native_round_echo']);
    assert.equal(bodies[0].tools[0].function.parameters.type, 'object');
    assert.deepEqual(bodies[0].tools[0].function.parameters.required, ['value']);
    assert.equal(bodies[1].messages.at(-2).role, 'assistant');
    assert.equal(bodies[1].messages.at(-2).tool_calls[0].function.name, 'native_round_echo');
    assert.equal(bodies[1].messages.at(-1).role, 'tool');
    assert.equal(bodies[1].messages.at(-1).tool_call_id, 'native_call_1');
    assert.equal(bodies[1].messages.at(-1).content, 'native:safe');

    const toolUse = events.find(event => event.type === 'assistant' && event.message?.content?.[0]?.type === 'tool_use');
    const toolResult = events.find(event => event.type === 'assistant' && event.message?.content?.[0]?.type === 'tool_result');
    assert.deepEqual(toolUse?.message.content[0], { type: 'tool_use', id: 'native_call_1', name: 'native_round_echo', input: { value: 'safe' } });
    assert.equal(toolResult?.message.content[0]?.tool_use_id, 'native_call_1');
    assert.equal(toolResult?.message.content[0]?.content, 'native:safe');
    assert.equal(toolResult?.message.content[0]?.is_error, false);

    const result = events.at(-1);
    assert.equal(result.subtype, 'success');
    assert.equal(result.result, 'Before native call.\n\nAfter native call.');
    assert.equal(result.total_cost_usd, 0.03);
    assert.deepEqual(result.usage, { prompt_tokens: 22, completion_tokens: 9, total_tokens: 31, cost: 0.03 });
    assert.equal(result.result.split('Before native call.').length - 1, 1, 'prose from tool-call round must aggregate exactly once');
  } finally { globalThis.fetch = origFetch; }
});

await checkAsync('finish_reason=length continues within the turn bound and aggregates exact prose once', async () => {
  let calls = 0;
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    bodies.push(JSON.parse(init.body));
    const message = calls === 1
      ? { finish_reason: 'length', content: 'First exact segment.' }
      : { finish_reason: 'stop', content: 'Second exact segment.' };
    return new Response(JSON.stringify({ choices: [{ finish_reason: message.finish_reason, message: { content: message.content } }] }), { status: 200 });
  };
  try {
    const provider = createOpenRouterProvider({ env: { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_STREAM: '0' } });
    const events = [];
    for await (const event of provider.query({ prompt: 'Produce a bounded continuation.', options: { maxTurns: 2, permissionMode: 'plan' } })) events.push(event);
    assert.equal(calls, 2);
    assert.equal(bodies[1].messages.at(-1).role, 'user');
    assert.equal(bodies[1].messages.at(-1).content, 'Continue from the exact cutoff without repeating prior text. Finish the answer.');
    const result = events.at(-1);
    assert.equal(result.subtype, 'success');
    assert.equal(result.result, 'First exact segment.\n\nSecond exact segment.');
    assert.equal(result.result.split('First exact segment.').length - 1, 1);
    assert.equal(result.result.split('Second exact segment.').length - 1, 1);
  } finally { globalThis.fetch = origFetch; }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
