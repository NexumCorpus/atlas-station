import assert from 'node:assert/strict';
import { createOpenRouterProvider } from '../providers/openrouter.mjs';

// Regression harness for native streaming transport failures: the reported
// 'read ECONNRESET [transport=native ...]' is thrown DURING the response-body
// read (after headers), so only a retry wrapped around the stream-body read
// can catch it. Invariant: retry only while zero semantic SSE output
// has been accepted; after any semantic output, fail honestly, no replay.

function sseResponse(chunks, failWith) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (failWith) setTimeout(() => controller.error(failWith), 20); // let the consumer drain enqueued frames first
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeEnv(extra = {}) {
  return { OPENROUTER_API_KEY: 'test-key', ATLAS_OPENROUTER_RETRY_BASE_MS: '500', ...extra };
}

async function collect(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const RESET = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

// --- Test A: reset BEFORE any semantic delta -> exactly 2 requests, success.
{
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return sseResponse([': OPENROUTER PROCESSING\n\n'], RESET);
    return sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }) + '\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  try {
    const provider = createOpenRouterProvider({ env: makeEnv({ ATLAS_OPENROUTER_HTTP_RETRIES: '2' }) });
    const events = await collect(provider.query({ prompt: 'hi', options: { atlasStatelessSession: true } }));
    assert.equal(calls, 2, `expected 2 requests, saw ${calls}`);
    const result = events.find((e) => e.type === 'result');
    assert.ok(result && result.subtype !== 'error' && result.subtype !== 'error_max_turns', 'must succeed after clean retry');
    assert.match(String(result.result), /hello/);
  } finally { globalThis.fetch = origFetch; }
  console.log('stream-reset-before-semantic-delta: PASS');
}

// --- Test B: partial semantic delta then reset -> EXACTLY ONE request, honest error, no replay.
{
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return sseResponse(
      ['data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n\n'],
      RESET,
    );
  };
  try {
    const provider = createOpenRouterProvider({ env: makeEnv({ ATLAS_OPENROUTER_HTTP_RETRIES: '3' }) });
    const events = await collect(provider.query({ prompt: 'hi', options: { atlasStatelessSession: true } }));
    assert.equal(calls, 1, `semantic output forbids replay; expected 1 request, saw ${calls}`);
    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 1);
    assert.ok(String(results[0].subtype).startsWith('error'), 'must surface an honest error');
    assert.match(String(results[0].result), /ECONNRESET|stream failed|failed/i);
    const streamedText = events.filter((e) => e.type === 'assistant_stream' && e.kind === 'text').map((e) => e.text).join('');
    assert.equal(streamedText, 'Hel', 'partial text must not be duplicated by a replay');
  } finally { globalThis.fetch = origFetch; }
  console.log('partial-delta-then-reset-no-replay: PASS');
}

console.log('openrouter-stream-retry: ALL PASS');
