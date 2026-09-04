import assert from 'node:assert/strict';
import { createOpenRouterProvider, resolveCompatibleProvider } from '../providers/openrouter.mjs';

const env = {
  ATLAS_PROVIDER: 'ollama',
  ATLAS_OLLAMA_MODEL: 'qwen3.5:9b',
  ATLAS_OLLAMA_API_URL: 'http://127.0.0.1:11434/api/chat',
  ATLAS_OPENROUTER_STREAM: '0',
};
assert.deepEqual(resolveCompatibleProvider(env), {
  id: 'ollama', apiUrl: env.ATLAS_OLLAMA_API_URL, apiKey: '', model: 'qwen3.5:9b', openRouterExtensions: false, source: 'ollama-local',
});
let captured;
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  return new Response(JSON.stringify({ message: { role: 'assistant', content: 'local-ok' }, done_reason: 'stop', prompt_eval_count: 2, eval_count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const provider = createOpenRouterProvider({ env });
  let final = '';
  for await (const event of provider.query({ prompt: 'probe', options: { maxTurns: 1 } })) if (event.type === 'result') final = event.result;
  assert.equal(final, 'local-ok');
  assert.equal(captured.url, env.ATLAS_OLLAMA_API_URL);
  assert.equal(captured.body.model, 'qwen3.5:9b');
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.options.num_ctx, 32768);
  assert(!('reasoning' in captured.body));
  assert(!('provider' in captured.body));
  assert(!('Authorization' in captured.init.headers));
} finally { globalThis.fetch = oldFetch; }

// Native Ollama tool continuations are not OpenAI wire format. Prove that the
// provider-neutral transcript is translated before the second model round.
const roundBodies = [];
let round = 0;
globalThis.fetch = async (_url, init) => {
  roundBodies.push(JSON.parse(init.body));
  round += 1;
  if (round === 1) {
    return new Response(JSON.stringify({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'probe_tool', arguments: { value: 7 } } }] },
      done_reason: 'stop',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: { role: 'assistant', content: 'tool-ok' }, done_reason: 'stop' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const provider = createOpenRouterProvider({ env });
  const probeTool = {
    definition: { type: 'function', function: { name: 'probe_tool', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } },
    execute: async ({ value }) => `value=${value}`,
  };
  let final = '';
  for await (const event of provider.query({ prompt: 'use the probe', options: { maxTurns: 2, openRouterTools: [probeTool], permissionMode: 'bypassPermissions' } })) if (event.type === 'result') final = event.result;
  assert.equal(final, 'tool-ok');
  const assistant = roundBodies[1].messages.find(message => message.role === 'assistant' && message.tool_calls);
  const tool = roundBodies[1].messages.find(message => message.role === 'tool');
  assert.deepEqual(assistant.tool_calls[0].function.arguments, { value: 7 });
  assert.equal(tool.tool_name, 'probe_tool');
  assert(!('tool_call_id' in tool));
} finally { globalThis.fetch = oldFetch; }

globalThis.fetch = async () => new Response(JSON.stringify({ error: 'native Ollama diagnostic' }), { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } });
try {
  const provider = createOpenRouterProvider({ env: { ...env, ATLAS_OPENROUTER_HTTP_RETRIES: '0' } });
  let failure = '';
  for await (const event of provider.query({ prompt: 'fail clearly', options: { maxTurns: 1 } })) if (event.type === 'result') failure = event.result;
  assert.match(failure, /native Ollama diagnostic/);
} finally { globalThis.fetch = oldFetch; }

console.log('ollama provider: OpenAI-compatible local route PASS');
