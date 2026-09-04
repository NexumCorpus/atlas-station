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
console.log('ollama provider: OpenAI-compatible local route PASS');
