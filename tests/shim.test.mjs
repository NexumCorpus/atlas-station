import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startShim } = require('../shims/openai-claude.cjs');

// OpenAI-shim acceptance (IMMUTABLE — the builder must not modify this file).
// The shim serves POST /v1/chat/completions and answers with a REAL local
// claude CLI call (subscription-billed, no API keys). This lets OpenRouter-
// shaped tools (RDE first) run with the station's own lineage in the model
// seat while their engines stay byte-identical.

const shim = await startShim({ port: 0 });   // ephemeral port
assert.ok(shim.port > 0, 'shim must report its port');
const base = `http://127.0.0.1:${shim.port}`;

// --- real completion round-trip ---------------------------------------------
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' },
    body: JSON.stringify({
      model: 'sonnet',
      messages: [
        { role: 'system', content: 'You answer with exactly one word.' },
        { role: 'user', content: 'Reply with exactly the word PONG' },
      ],
    }),
  });
  assert.strictEqual(res.status, 200, 'completion must return 200');
  const body = await res.json();
  const msg = body?.choices?.[0]?.message;
  assert.strictEqual(msg?.role, 'assistant');
  assert.ok(/PONG/i.test(msg?.content || ''), 'real model reply expected, got: ' + msg?.content);
  assert.ok(body.usage && typeof body.usage.completion_tokens === 'number',
    'usage tokens must be reported (RDE ledgers them)');
  assert.strictEqual(body.object, 'chat.completion');
}

// --- malformed request: clean 400, never a crash -----------------------------
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'error body must explain');
}

// --- unknown path -------------------------------------------------------------
{
  const res = await fetch(`${base}/v1/nope`, { method: 'POST', body: '{}' });
  assert.strictEqual(res.status, 404);
}

await shim.close();
console.log('openai shim: ALL PASS');
process.exit(0);
