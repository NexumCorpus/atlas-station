import { createOpenRouterProvider } from "./openrouter.mjs";

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

export function resolveColibriConfig(env = process.env) {
  const baseUrl = String(env.ATLAS_COLIBRI_API_URL || "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
  const apiRoot = baseUrl.endsWith("/chat/completions")
    ? baseUrl.slice(0, -"/chat/completions".length)
    : baseUrl;
  return Object.freeze({
    enabled: String(env.ATLAS_COLD_PROVIDER || "").toLowerCase() === "colibri",
    provider: "colibri",
    model: env.ATLAS_COLIBRI_MODEL || "glm-5.2-colibri",
    apiRoot,
    healthUrl: `${apiRoot.replace(/\/v1$/, "")}/health`,
    cacheSlot: boundedInt(env.ATLAS_COLIBRI_CACHE_SLOT, 1, 0, 15),
    requestTimeoutMs: boundedInt(env.ATLAS_COLIBRI_REQUEST_TIMEOUT_MS, 1_200_000, 1_000, 86_400_000),
    healthTimeoutMs: boundedInt(env.ATLAS_COLIBRI_HEALTH_TIMEOUT_MS, 1_500, 100, 30_000),
  });
}

export function normalizeColibriHealth(payload = {}, config = resolveColibriConfig({})) {
  const scheduler = payload.scheduler && typeof payload.scheduler === "object" ? payload.scheduler : payload;
  const count = key => Math.max(0, Number(scheduler?.[key]) || 0);
  return {
    configured: config.enabled,
    online: true,
    provider: "colibri",
    model: config.model,
    cacheSlot: config.cacheSlot,
    active: count("active"),
    queued: count("queued"),
    completed: count("completed"),
    rejected: count("rejected"),
  };
}

export function createColibriColdProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = resolveColibriConfig(env);
  const providerEnv = {
    ...env,
    ATLAS_PROVIDER: "colibri",
    ATLAS_COLIBRI_API_URL: config.apiRoot,
    ATLAS_COLIBRI_MODEL: config.model,
    ATLAS_COLIBRI_CACHE_SLOT: String(config.cacheSlot),
    ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs),
    // Long local prefills need streaming keepalive; never silently force the
    // legacy non-streaming path unless the operator explicitly requests it.
    ATLAS_OPENROUTER_STREAM: env.ATLAS_COLIBRI_STREAM ?? "1",
  };
  const inner = createOpenRouterProvider({ env: providerEnv });
  return {
    name: "colibri",
    enabled: config.enabled,
    config,
    capabilities: inner.capabilities,
    assign() {
      return { purpose: "cold-cortex", route: "colibri-kv", model: config.model, source: "colibri-cold-cortex", cacheSlot: config.cacheSlot };
    },
    probe() {
      return { configured: config.enabled, available: null, provider: "colibri", model: config.model, cacheSlot: config.cacheSlot, api: "chat-completions-sse" };
    },
    async probeHealth() {
      if (!config.enabled) return { ...this.probe(), online: false, state: "disabled", active: 0, queued: 0, completed: 0, rejected: 0 };
      const signal = AbortSignal.timeout(config.healthTimeoutMs);
      try {
        const headers = env.ATLAS_COLIBRI_API_KEY ? { Authorization: `Bearer ${env.ATLAS_COLIBRI_API_KEY}` } : {};
        const response = await fetchImpl(config.healthUrl, { method: "GET", headers, signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { ...normalizeColibriHealth(await response.json(), config), state: "ready" };
      } catch (error) {
        return { ...this.probe(), online: false, state: "offline", active: 0, queued: 0, completed: 0, rejected: 0, reason: String(error?.message || error).slice(0, 180) };
      }
    },
    query(args) {
      if (!config.enabled) throw new Error("Colibri cold cortex is disabled; set ATLAS_COLD_PROVIDER=colibri");
      return inner.query(args);
    },
  };
}
