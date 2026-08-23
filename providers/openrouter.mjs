import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "stealth/ox-alpha";
const DEFAULT_ROUNDS = 24;
const MAX_ROUNDS = 256;
const MAX_TOOL_OUTPUT = 20_000;
const sessions = new Map();
const providerStartedAt = new Date().toISOString();
const isolatedDispatcher = new Agent({ connections: 2, pipelining: 0 });
const POWERSHELL_TRANSPORT = fileURLToPath(new URL("./openrouter-transport.ps1", import.meta.url));
const TOOLS = [{
  type: "function",
  function: {
    name: "shell",
    description: "Run a PowerShell command in the current Atlas workspace. Use it to inspect, edit, test, and operate Hermes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 1_200_000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
}];

function bounded(value, limit = MAX_TOOL_OUTPUT) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function safeError(error) {
  const status = error?.status ? `HTTP ${error.status}: ` : "";
  const cause = error?.cause;
  const causeLabel = cause?.code || cause?.message;
  const socket = cause?.socket;
  const socketLabel = socket
    ? ` family=${socket.remoteFamily || "unknown"} written=${Number(socket.bytesWritten) || 0} read=${Number(socket.bytesRead) || 0}`
    : "";
  const detail = causeLabel ? ` (${causeLabel}${socketLabel})` : "";
  return bounded(`${status}${error?.message || error || "OpenRouter request failed"}${detail}`, 1_200);
}

export function decodePowerShellResponseEnvelope(stdout) {
  const envelope = JSON.parse(stdout);
  return {
    ...envelope,
    body: envelope.bodyB64
      ? Buffer.from(String(envelope.bodyB64), "base64").toString("utf8")
      : String(envelope.body || ""),
  };
}

async function fetchBeforeResponse(url, init, env) {
  const transport = String(env.ATLAS_OPENROUTER_TRANSPORT || "global").toLowerCase();
  const requestFetch = transport === "native"
    ? nativeFetch
    : transport === "powershell"
      ? powershellFetch
    : transport === "isolated"
      ? (target, requestInit) => undiciFetch(target, { ...requestInit, dispatcher: isolatedDispatcher })
      : globalThis.fetch;
  return requestFetch(url, init);
}

function powershellFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", POWERSHELL_TRANSPORT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const abort = () => child.kill();
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      init.signal?.removeEventListener("abort", abort);
      if (init.signal?.aborted) {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        return;
      }
      if (code !== 0) {
        reject(new Error(bounded(stderr || `PowerShell transport exited ${code}`, 1_200)));
        return;
      }
      try {
        const envelope = decodePowerShellResponseEnvelope(stdout);
        const responseBody = envelope.body;
        resolve({
          ok: envelope.status >= 200 && envelope.status < 300,
          status: Number(envelope.status) || 0,
          statusText: String(envelope.statusText || ""),
          admitted: envelope.admitted === true,
          transportError: envelope.transportError ? bounded(envelope.transportError, 1_200) : null,
          body: Readable.from([responseBody]),
          async json() { return responseBody ? JSON.parse(responseBody) : {}; },
          async text() { return responseBody; },
        });
      } catch (error) {
        reject(new Error(`PowerShell transport returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ url, headers: init.headers || {}, body: String(init.body || ""), maxResponseBytes: 16_777_216 }));
  });
}

function nativeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const body = String(init.body || "");
    const headers = { ...init.headers, "Content-Length": Buffer.byteLength(body, "utf8") };
    const request = https.request(url, { method: init.method || "GET", headers, agent: false }, (response) => {
      let consumed = false;
      const consume = async () => {
        if (consumed) return "";
        consumed = true;
        const chunks = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString("utf8");
      };
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode || 0,
        statusText: response.statusMessage || "",
        body: response,
        async json() { const text = await consume(); return text ? JSON.parse(text) : {}; },
        text: consume,
      });
    });
    const abort = () => request.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => init.signal?.removeEventListener("abort", abort));
    request.end(body);
  });
}

function systemPrompt(options) {
  const append = typeof options.systemPrompt === "object" ? options.systemPrompt?.append : options.systemPrompt;
  return [
    "You are ATLAS, the executive cortex and speaking surface of Hermes.",
    "Hermes is the entire local organism: Station is its spine and notary; shards are lossless tissue; crystals and spoor are durable memory; spirals are measured self-improvement; Boundary and the Wall are adversarial reality checks.",
    "You have a direct shell organ in the current workspace. Use it instead of merely describing work. Ground claims in live evidence, preserve append-only provenance, and never print credentials or authorization headers.",
    "Speak naturally in the present tense. Do not repeat provider constraints unless asked or concretely blocked. Continue until the operator's task is actually complete.",
    typeof append === "string" ? append : "",
  ].filter(Boolean).join("\n\n");
}

function toolEnvironment(env) {
  const clean = { ...env };
  delete clean.OPENROUTER_API_KEY;
  return clean;
}

export function boundedToolTimeout(input, ceilingMs = 1_200_000) {
  const requested = Math.max(1_000, Number(input?.timeout_ms) || 120_000);
  const ceiling = Math.max(1_000, Math.min(1_200_000, Number(ceilingMs) || 1_200_000));
  return Math.min(requested, ceiling);
}

function validateToolInput(schema, input, at = 'input') {
  if (!schema) return null;
  if (schema.type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return `${at} must be an object`;
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!(key in input)) return `${at}.${key} is required`;
    if (schema.additionalProperties === false) for (const key of Object.keys(input)) if (!(key in properties)) return `${at}.${key} is not allowed`;
    for (const [key, value] of Object.entries(input)) {
      const error = validateToolInput(properties[key], value, `${at}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(input)) return `${at} must be an array`;
    if (schema.minItems != null && input.length < schema.minItems) return `${at} needs at least ${schema.minItems} items`;
    if (schema.maxItems != null && input.length > schema.maxItems) return `${at} allows at most ${schema.maxItems} items`;
    for (let i = 0; i < input.length; i++) {
      const error = validateToolInput(schema.items, input[i], `${at}[${i}]`);
      if (error) return error;
    }
  } else if (schema.type === 'string') {
    if (typeof input !== 'string') return `${at} must be a string`;
    if (schema.minLength != null && input.length < schema.minLength) return `${at} is too short`;
    if (schema.maxLength != null && input.length > schema.maxLength) return `${at} is too long`;
    if (schema.enum && !schema.enum.includes(input)) return `${at} is not an allowed value`;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof input !== 'number' || !Number.isFinite(input) || (schema.type === 'integer' && !Number.isInteger(input))) return `${at} must be a ${schema.type}`;
    if (schema.minimum != null && input < schema.minimum) return `${at} is below ${schema.minimum}`;
    if (schema.maximum != null && input > schema.maximum) return `${at} is above ${schema.maximum}`;
  }
  return null;
}

async function timeBoundTool(run, ceilingMs, parentSignal) {
  const timeout = Math.max(1_000, Math.min(1_200_000, Number(ceilingMs) || 1_200_000));
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timer;
  try {
    if (signal.aborted) return "cancelled";
    return await Promise.race([
      Promise.resolve().then(() => run(signal)),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(`timeout after ${timeout}ms`); }, timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runShell(input, cwd, env, signal, ceilingMs) {
  return new Promise((resolve) => {
    const command = String(input?.command || "");
    const timeout = boundedToolTimeout(input, ceilingMs);
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd, env: toolEnvironment(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let settled = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(`timeout after ${timeout}ms`); }, timeout);
    const abort = () => { try { child.kill(); } catch {} finish("cancelled"); };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(safeError(error)));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      finish(bounded(`exit=${code}\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}`));
    });
  });
}

function requestBody(messages, env, stream, tools = TOOLS) {
  const body = {
    model: env.ATLAS_OPENROUTER_MODEL || env.ATLAS_CODEX_MODEL || DEFAULT_MODEL,
    messages,
    reasoning: { effort: env.ATLAS_OPENROUTER_REASONING || "max" },
    max_tokens: Number(env.ATLAS_OPENROUTER_MAX_TOKENS) || 32_768,
    provider: {
      sort: env.ATLAS_OPENROUTER_PROVIDER_SORT || "latency",
      allow_fallbacks: true,
      require_parameters: true,
      preferred_max_latency: Number(env.ATLAS_OPENROUTER_PREFERRED_MAX_LATENCY) || 15,
    },
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (stream) {
    body.stream = true;
    body.usage = { include: true }; // final SSE chunk carries token accounting
  }
  return body;
}

function authHeaders(env) {
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/NexumCorpus/atlas-station",
    "X-Title": "Atlas Station",
  };
}

function requestMetrics(messages, env, stream, tools) {
  return {
    requestBytes: Buffer.byteLength(JSON.stringify(requestBody(messages, env, stream, tools)), "utf8"),
    messages: messages.length,
    stream,
    tools: tools.length,
    transport: String(env.ATLAS_OPENROUTER_TRANSPORT || "global").toLowerCase(),
  };
}

function waitForRetry(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(true); }, ms);
    const abort = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function request(messages, env, signal, tools) {
  const requestTimeout = Math.min(1_200_000, Math.max(1_000, Number(env.ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS) || 1_200_000));
  const timeoutSignal = AbortSignal.timeout(requestTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const requestJson = JSON.stringify(requestBody(messages, env, false, tools));
  const configuredRetries = Number(env.ATLAS_OPENROUTER_HTTP_RETRIES);
  const retries = Math.max(0, Math.min(3, Number.isFinite(configuredRetries) ? configuredRetries : 2));
  const retryBaseMs = Math.max(500, Math.min(15_000, Number(env.ATLAS_OPENROUTER_RETRY_BASE_MS) || 3_000));
  const transientStatuses = new Set([429]);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetchBeforeResponse(API_URL, {
      method: "POST",
      signal: requestSignal,
      headers: authHeaders(env),
      body: requestJson,
    }, env);
    if (response.transportError) throw new Error(`OpenRouter response body failed after admission: ${response.transportError}`);
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (transientStatuses.has(response.status) && attempt < retries && await waitForRetry(retryBaseMs * (attempt + 1), requestSignal)) continue;
    const error = new Error(payload?.error?.message || response.statusText || "OpenRouter request failed");
    error.status = response.status;
    throw error;
  }
  return {};
}

// Streaming variant: parses OpenRouter SSE chunks, forwards text / reasoning /
// tool_call deltas to onDelta as they arrive, and resolves with the assembled
// message + usage. Handles both delta.reasoning and delta.reasoning_content.
async function requestStreaming(messages, env, signal, onDelta, tools) {
  const requestTimeout = Math.min(1_200_000, Math.max(1_000, Number(env.ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS) || 1_200_000));
  const timeoutSignal = AbortSignal.timeout(requestTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const requestJson = JSON.stringify(requestBody(messages, env, true, tools));
  const response = await fetchBeforeResponse(API_URL, {
    method: "POST",
    signal: requestSignal,
    headers: authHeaders(env),
    body: requestJson,
  }, env);
  if (response.transportError) throw new Error(`OpenRouter response body failed after admission: ${response.transportError}`);
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error?.message || response.statusText || "OpenRouter request failed");
    error.status = response.status;
    throw error;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolAcc = new Map(); // index -> { id, name, args }
  let usage = null;
  let finishReason = null;
  streamLoop: for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skips SSE comments (e.g. ": OPENROUTER PROCESSING")
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") break streamLoop;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      const rText = d.reasoning ?? d.reasoning_content;
      if (typeof rText === "string" && rText) { reasoning += rText; onDelta?.({ kind: "thinking", text: rText }); }
      if (typeof d.content === "string" && d.content) { content += d.content; onDelta?.({ kind: "text", text: d.content }); }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          let slot = toolAcc.get(idx);
          if (!slot) { slot = { id: "", name: "", args: "" }; toolAcc.set(idx, slot); }
          if (tc.id) slot.id = String(tc.id);
          if (tc.function?.name) slot.name += String(tc.function.name);
          if (tc.function?.arguments) {
            slot.args += String(tc.function.arguments);
            onDelta?.({ kind: "tool_arg", index: idx });
          }
        }
      }
    }
  }
  const tool_calls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => ({ id: s.id || `call_${s.name}`, type: "function", function: { name: s.name || "shell", arguments: s.args || "{}" } }));
  return {
    message: {
      content: content || null,
      reasoning: reasoning || null, // surfaced for telemetry; never persisted back into chat history
      tool_calls: tool_calls.length ? tool_calls : undefined,
    },
    usage,
    finish_reason: finishReason,
  };
}

// Minimal async channel so the async-generator query() can interleave live
// deltas (yielded as they arrive) with the final consolidated round result.
function deltaChannel() {
  const buf = [];
  let wake = null;
  let state = "open"; // open | closed | errored
  let error = null;
  return {
    push(item) {
      if (state !== "open") return;
      if (wake) { const w = wake; wake = null; w(item); } else buf.push(item);
    },
    close() { state = "closed"; if (wake) { const w = wake; wake = null; w(null); } },
    fail(err) { state = "errored"; error = err; if (wake) { const w = wake; wake = null; w(null); } },
    async *drain() {
      while (true) {
        if (buf.length) { yield buf.shift(); continue; }
        if (state === "open") {
          const item = await new Promise((res) => { wake = res; });
          if (item) yield item;
          continue;
        }
        if (state === "errored") throw error;
        return;
      }
    },
  };
}

export function createOpenRouterProvider({ env = process.env } = {}) {
  const model = env.ATLAS_OPENROUTER_MODEL || env.ATLAS_CODEX_MODEL || DEFAULT_MODEL;
  // ATLAS_OPENROUTER_STREAM=0 forces the legacy non-streaming path (fallback
  // safety: a stream-parser regression must never brick the organism).
  const streamingEnabled = String(env.ATLAS_OPENROUTER_STREAM ?? "1") !== "0";
  return {
    name: "openrouter",
    capabilities: Object.freeze({ maxTurns: true, disallowedTools: true, canUseTool: true, permissionMode: "caller-declared", mcpServers: false, nativeTools: true }),
    assign() { return { purpose: "organism", route: "openrouter", model, source: "openrouter-directive" }; },
    probe() {
      return {
        available: Boolean(env.OPENROUTER_API_KEY),
        credentialConfigured: Boolean(env.OPENROUTER_API_KEY),
        model,
        api: streamingEnabled ? "chat-completions-sse" : "chat-completions",
        transport: String(env.ATLAS_OPENROUTER_TRANSPORT || "global").toLowerCase(),
      };
    },
    async *query({ prompt, options = {} } = {}) {
      if (!env.OPENROUTER_API_KEY) {
        yield { type: "result", subtype: "error", result: "OPENROUTER_API_KEY is not configured", total_cost_usd: null };
        return;
      }
      const statelessSession = options.atlasStatelessSession === true;
      const sessionId = !statelessSession && options.resume && sessions.has(options.resume)
        ? options.resume
        : `openrouter:${randomUUID()}`;
      const messages = sessions.get(sessionId) || [{ role: "system", content: systemPrompt(options) }];
      const disallowed = new Set((options.disallowedTools || []).map((name) => String(name).toLowerCase()));
      const toolsAdvertised = options.permissionMode !== 'plan';
      const shellAdvertised = toolsAdvertised && !disallowed.has('shell') && !disallowed.has('bash');
      const nativeTools = Array.isArray(options.openRouterTools)
        ? options.openRouterTools.filter((item) => item?.definition?.function?.name && typeof item.execute === 'function')
        : [];
      const nativeByName = new Map(nativeTools.map((item) => [item.definition.function.name, item]));
      const availableTools = [
        ...(shellAdvertised ? TOOLS : []),
        ...(toolsAdvertised ? nativeTools : [])
          .filter((item) => !disallowed.has(item.definition.function.name.toLowerCase()))
          .map((item) => item.definition),
      ];
      messages.push({ role: "user", content: Array.isArray(prompt) ? prompt : String(prompt || "") }); // arrays = multimodal blocks (paste-image spec 98f8861)
      if (!statelessSession) sessions.set(sessionId, messages);
      yield { type: "system", subtype: "init", session_id: sessionId };
      options.onProviderSpawn?.({ pid: process.pid, startIdentity: `${process.pid}:${providerStartedAt}`, providerSessionId: sessionId, providerModel: model, provider: "openrouter", statelessSession, toolCount: availableTools.length });
      try {
        const configuredDefault = Number(env.ATLAS_OPENROUTER_MAX_ROUNDS) || DEFAULT_ROUNDS;
        const turnCap = Math.max(1, Math.min(MAX_ROUNDS, Number(options.maxTurns) || configuredDefault));
        for (let round = 0; round < turnCap; round++) {
          let message; let usage;
          if (streamingEnabled) {
            const ch = deltaChannel();
            const pump = requestStreaming(messages, env, options.abortSignal, (d) => ch.push(d), availableTools)
              .then((r) => { ch.close(); return r; })
              .catch((e) => { ch.fail(e); return null; });
            for await (const d of ch.drain()) {
              if (d.kind === "thinking") yield { type: "assistant_stream", kind: "thinking", text: d.text };
              else if (d.kind === "text") yield { type: "assistant_stream", kind: "text", text: d.text };
              else if (d.kind === "tool_arg") yield { type: "assistant_stream", kind: "tool_arg", index: d.index };
            }
            const assembled = await pump;
            if (!assembled) throw new Error("OpenRouter stream failed");
            message = assembled.message;
            usage = assembled.usage;
          } else {
            const payload = await request(messages, env, options.abortSignal, availableTools);
            message = payload?.choices?.[0]?.message;
            usage = payload?.usage || null;
            if (!message) {
              const diagnostic = {
                keys: Object.keys(payload || {}).slice(0, 12),
                choices: Array.isArray(payload?.choices) ? payload.choices.length : null,
                error: bounded(payload?.error?.message || payload?.error?.code || "", 300),
                provider: bounded(payload?.provider || "", 120),
              };
              const metrics = requestMetrics(messages, env, streamingEnabled, availableTools);
              yield {
                type: "result",
                subtype: "error",
                result: `OpenRouter returned no assistant message ${JSON.stringify(diagnostic)} [transport=${metrics.transport} stream=${Number(metrics.stream)} messages=${metrics.messages} requestBytes=${metrics.requestBytes} tools=${metrics.tools}]`,
                total_cost_usd: null,
              };
              return;
            }
          }
          messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls || undefined });
          if (message.content) yield { type: "assistant", message: { content: [{ type: "text", text: String(message.content) }] } };
          const calls = message.tool_calls || [];
          if (!calls.length) {
            if (!String(message.content || "").trim()) {
              if (round + 1 < turnCap) {
                messages.push({ role: "user", content: "Your prior response contained no visible content. Return a non-empty direct answer to the operator now." });
                continue;
              }
              yield { type: "result", subtype: "error_max_turns", result: "OpenRouter exhausted the turn bound without visible assistant content", total_cost_usd: usage?.cost ?? null, usage: usage || null };
              return;
            }
            yield { type: "result", subtype: "success", result: String(message.content || ""), total_cost_usd: usage?.cost ?? 0, usage: usage || null };
            return;
          }
          const prepared = calls.map((call) => {
            let input = {};
            let parseError = null;
            try { input = JSON.parse(call.function?.arguments || "{}"); } catch (error) { parseError = `invalid JSON: ${error.message}`; }
            return { call, input, parseError, toolName: call.function?.name || 'shell' };
          });
          for (const item of prepared) yield { type: "assistant", message: { content: [{ type: "tool_use", name: item.toolName, input: item.input }] } };
          const completed = [];
          let serialToolTail = Promise.resolve();
          const outputs = await Promise.all(prepared.map(({ call, input, parseError, toolName }, index) => {
            const nativeTool = nativeByName.get(toolName);
            const runPrepared = async () => {
            const startedAt = Date.now();
            try {
              if (parseError) return `tool denied: ${parseError}`;
              const schema = nativeTool?.definition?.function?.parameters || (toolName === 'shell' ? TOOLS[0].function.parameters : null);
              const validationError = validateToolInput(schema, input);
              if (validationError) return `tool denied: ${validationError}`;
              let admittedInput = input;
              if (typeof options.canUseTool === 'function') {
                const verdict = await options.canUseTool(toolName, input, { provider: 'openrouter', sessionId });
                if (!verdict || verdict.behavior !== 'allow') return `tool denied: ${verdict?.message || 'caller policy'}`;
                if (verdict.updatedInput && typeof verdict.updatedInput === 'object') admittedInput = verdict.updatedInput;
              }
              if (nativeTool) {
                try {
                  const nativeTimeout = Math.max(1_000, Math.min(1_200_000, Number(options.atlasToolTimeoutMs) || 1_200_000));
                  const deadlineAt = Date.now() + nativeTimeout;
                  return bounded(await timeBoundTool(
                    signal => nativeTool.execute(admittedInput, { signal, sessionId, deadlineAt }),
                    nativeTimeout,
                    options.abortSignal,
                  ), MAX_TOOL_OUTPUT);
                } catch (error) {
                  return `tool error: ${safeError(error)}`;
                }
              }
              if (toolName !== 'shell') return `unsupported tool: ${toolName}`;
              if (!shellAdvertised) return "tool denied by provider capability policy";
              return runShell(admittedInput, options.cwd || env.ATLAS_REPO || process.cwd(), env, options.abortSignal, options.atlasToolTimeoutMs);
            } finally {
              completed.push({ index, name: toolName, durationMs: Date.now() - startedAt });
            }
            };
            if (nativeTool?.parallelSafe === true) return runPrepared();
            const scheduled = serialToolTail.then(runPrepared, runPrepared);
            serialToolTail = scheduled.then(() => undefined, () => undefined);
            return scheduled;
          }));
          for (let i = 0; i < prepared.length; i++) messages.push({ role: "tool", tool_call_id: prepared[i].call.id, content: outputs[i] });
          options.onToolBatch?.({
            sessionId,
            emittedOrder: prepared.map((item, index) => ({ index, name: item.toolName })),
            completionOrder: completed,
            receiptOrder: prepared.map((item, index) => ({ index, name: item.toolName })),
          });
        }
        // Loop exited by round-cap => exhaustion. Classified distinctly so the
        // station can one-shot-retry the run class (matches SDK error_max_turns).
        const namedCeiling = turnCap === configuredDefault ? configuredDefault : MAX_ROUNDS;
        yield { type: "result", subtype: "error_max_turns", result: `Run exhausted its ${turnCap}-tool-round bound (provider ceiling ${namedCeiling})`, total_cost_usd: null };
      } catch (error) {
        const metrics = requestMetrics(messages, env, streamingEnabled, availableTools);
        yield {
          type: "result",
          subtype: "error",
          result: `${safeError(error)} [transport=${metrics.transport} stream=${Number(metrics.stream)} messages=${metrics.messages} requestBytes=${metrics.requestBytes} tools=${metrics.tools}]`,
          total_cost_usd: null,
        };
      }
    },
  };
}
