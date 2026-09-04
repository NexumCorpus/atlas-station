import assert from "node:assert/strict";
import { createColibriColdProvider, normalizeColibriHealth, resolveColibriConfig } from "../providers/colibri.mjs";

const config = resolveColibriConfig({
  ATLAS_COLD_PROVIDER: "colibri",
  ATLAS_COLIBRI_API_URL: "http://127.0.0.1:9000/v1/",
  ATLAS_COLIBRI_MODEL: "test-colibri",
  ATLAS_COLIBRI_CACHE_SLOT: "99",
});
assert.equal(config.enabled, true);
assert.equal(config.healthUrl, "http://127.0.0.1:9000/health");
assert.equal(config.cacheSlot, 15);
assert.deepEqual(normalizeColibriHealth({ active: 1, queued: 3, completed: 8, rejected: 2 }, config), {
  configured: true, online: true, provider: "colibri", model: "test-colibri", cacheSlot: 15,
  active: 1, queued: 3, completed: 8, rejected: 2,
});

let requested;
const cold = createColibriColdProvider({
  env: { ATLAS_COLD_PROVIDER: "colibri", ATLAS_COLIBRI_API_URL: "http://localhost:8000/v1", ATLAS_COLIBRI_MODEL: "glm-test" },
  fetchImpl: async (url, init) => {
    requested = { url, init };
    return { ok: true, async json() { return { scheduler: { active: 0, queued: 2, completed: 5, rejected: 1 } }; } };
  },
});
assert.equal(cold.assign().purpose, "cold-cortex");
assert.equal(cold.assign().cacheSlot, 1);
const health = await cold.probeHealth();
assert.equal(requested.url, "http://localhost:8000/health");
assert.equal(health.state, "ready");
assert.equal(health.queued, 2);

const originalFetch = globalThis.fetch;
let completionBody;
globalThis.fetch = async (_url, init) => {
  completionBody = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    async json() { return { choices: [{ message: { content: "cold result" }, finish_reason: "stop" }], usage: {} }; },
    async text() { return JSON.stringify({ choices: [{ message: { content: "cold result" }, finish_reason: "stop" }], usage: {} }); },
  };
};
try {
  const queryProvider = createColibriColdProvider({ env: {
    ATLAS_COLD_PROVIDER: "colibri", ATLAS_COLIBRI_MODEL: "glm-test",
    ATLAS_COLIBRI_CACHE_SLOT: "4", ATLAS_COLIBRI_STREAM: "0",
  } });
  const events = [];
  for await (const event of queryProvider.query({ prompt: "bounded experiment", options: { permissionMode: "plan", maxTurns: 1 } })) events.push(event);
  assert.equal(events.at(-1).subtype, "success");
  assert.equal(completionBody.cache_slot, 4);
  assert.equal(completionBody.x_colibri_ignore_leading_stop, true);
  assert.equal(completionBody.enable_thinking, true);
  assert.equal("provider" in completionBody, false, "OpenRouter-only routing fields must not leak to Colibri");
} finally {
  globalThis.fetch = originalFetch;
}

const disabled = createColibriColdProvider({ env: {} });
assert.equal((await disabled.probeHealth()).state, "disabled");
assert.throws(() => disabled.query({ prompt: "never admitted" }), /disabled/);

const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../fleethost.mjs", import.meta.url), "utf8"));
assert.match(source, /source === 'long-mind' && _colibriColdProvider\.enabled/);
assert.match(source, /if \(!health\.online \|\| health\.active > 0 \|\| health\.queued > 0\)/);
assert.match(source, /query\(\{[\s\S]*usesColdCortex \? _colibriColdProvider : null\)/);
console.log("colibri provider: config, health, queue, and cold-only admission PASS");
