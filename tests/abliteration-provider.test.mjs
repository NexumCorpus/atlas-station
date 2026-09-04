import assert from "node:assert/strict";
import {
  createOpenRouterProvider,
  resolveCompatibleProvider,
} from "../providers/openrouter.mjs";

const env = {
  ATLAS_PROVIDER: "abliteration",
  ABLITERATION_API_KEY: "test-abliteration-key",
  ATLAS_ABLITERATION_MODEL: "abliterated-model-large-v2",
  ATLAS_OPENROUTER_STREAM: "0",
};

const resolved = resolveCompatibleProvider(env);
assert.equal(resolved.id, "abliteration");
assert.equal(resolved.apiUrl,
  "https://api.abliteration.ai/v1/chat/completions");
assert.equal(resolved.model, "abliterated-model-large-v2");
assert.equal(resolved.openRouterExtensions, false);

let observed = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  observed = { url: String(url), init, body: JSON.parse(init.body) };
  return new Response(JSON.stringify({
    choices: [{ message: { content: "Atlas inhabited." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const provider = createOpenRouterProvider({ env });
  assert.equal(provider.name, "abliteration");
  assert.deepEqual(provider.assign(), {
    purpose: "organism",
    route: "abliteration",
    model: "abliterated-model-large-v2",
    source: "abliteration-directive",
  });
  assert.equal(provider.probe().provider, "abliteration");
  const events = [];
  for await (const event of provider.query({
    prompt: "possess Atlas",
    options: { atlasStatelessSession: true, permissionMode: "plan" },
  })) events.push(event);
  assert.equal(events.at(-1).subtype, "success");
  assert.equal(events.at(-1).result, "Atlas inhabited.");
  assert.equal(observed.url,
    "https://api.abliteration.ai/v1/chat/completions");
  assert.equal(observed.init.headers.Authorization,
    "Bearer test-abliteration-key");
  assert.equal(observed.body.model, "abliterated-model-large-v2");
  assert.equal("provider" in observed.body, false,
    "OpenRouter routing extensions must not leak to another gateway");
  assert.equal("reasoning" in observed.body, false,
    "OpenRouter reasoning controls must not leak to another gateway");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("abliteration provider: ALL PASS");
