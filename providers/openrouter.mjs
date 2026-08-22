import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "stealth/ox-alpha";
const DEFAULT_ROUNDS = 24;
const MAX_ROUNDS = 256;
const MAX_TOOL_OUTPUT = 20_000;
const sessions = new Map();
const providerStartedAt = new Date().toISOString();

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
  return bounded(`${status}${error?.message || error || "OpenRouter request failed"}`, 1_200);
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

function runShell(input, cwd, env, signal) {
  return new Promise((resolve) => {
    const command = String(input?.command || "");
    const timeout = Math.min(1_200_000, Math.max(1_000, Number(input?.timeout_ms) || 120_000));
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

async function request(messages, env, signal, tools) {
  const requestTimeout = Math.min(1_200_000, Math.max(1_000, Number(env.ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS) || 300_000));
  const timeoutSignal = AbortSignal.timeout(requestTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(API_URL, {
    method: "POST",
    signal: requestSignal,
    headers: authHeaders(env),
    body: JSON.stringify(requestBody(messages, env, false, tools)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || response.statusText || "OpenRouter request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

// Streaming variant: parses OpenRouter SSE chunks, forwards text / reasoning /
// tool_call deltas to onDelta as they arrive, and resolves with the assembled
// message + usage. Handles both delta.reasoning and delta.reasoning_content.
async function requestStreaming(messages, env, signal, onDelta, tools) {
  const requestTimeout = Math.min(1_200_000, Math.max(1_000, Number(env.ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS) || 300_000));
  const timeoutSignal = AbortSignal.timeout(requestTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(API_URL, {
    method: "POST",
    signal: requestSignal,
    headers: authHeaders(env),
    body: JSON.stringify(requestBody(messages, env, true, tools)),
  });
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
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skips SSE comments (e.g. ": OPENROUTER PROCESSING")
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
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
    capabilities: Object.freeze({ maxTurns: true, disallowedTools: true, canUseTool: true, permissionMode: "caller-declared", mcpServers: false }),
    assign() { return { purpose: "organism", route: "openrouter", model, source: "openrouter-directive" }; },
    probe() { return { available: Boolean(env.OPENROUTER_API_KEY), credentialConfigured: Boolean(env.OPENROUTER_API_KEY), model, api: streamingEnabled ? "chat-completions-sse" : "chat-completions" }; },
    async *query({ prompt, options = {} } = {}) {
      if (!env.OPENROUTER_API_KEY) {
        yield { type: "result", subtype: "error", result: "OPENROUTER_API_KEY is not configured", total_cost_usd: null };
        return;
      }
      const sessionId = options.resume && sessions.has(options.resume) ? options.resume : `openrouter:${randomUUID()}`;
      const messages = sessions.get(sessionId) || [{ role: "system", content: systemPrompt(options) }];
      const disallowed = new Set((options.disallowedTools || []).map((name) => String(name).toLowerCase()));
      const shellAdvertised = !disallowed.has('shell') && !disallowed.has('bash') && options.permissionMode !== 'plan';
      const availableTools = shellAdvertised ? TOOLS : [];
      messages.push({ role: "user", content: Array.isArray(prompt) ? prompt : String(prompt || "") }); // arrays = multimodal blocks (paste-image spec 98f8861)
      sessions.set(sessionId, messages);
      yield { type: "system", subtype: "init", session_id: sessionId };
      options.onProviderSpawn?.({ pid: process.pid, startIdentity: `${process.pid}:${providerStartedAt}`, providerSessionId: sessionId, providerModel: model, provider: "openrouter" });
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
            if (!message) throw new Error("OpenRouter returned no assistant message");
          }
          messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls || undefined });
          if (message.content) yield { type: "assistant", message: { content: [{ type: "text", text: String(message.content) }] } };
          const calls = message.tool_calls || [];
          if (!calls.length) {
            yield { type: "result", subtype: "success", result: String(message.content || ""), total_cost_usd: usage?.cost ?? 0, usage: usage || null };
            return;
          }
          for (const call of calls) {
            let input = {};
            try { input = JSON.parse(call.function?.arguments || "{}"); } catch {}
            yield { type: "assistant", message: { content: [{ type: "tool_use", name: call.function?.name || "shell", input }] } };
            let output;
            if (call.function?.name !== "shell") output = `unsupported tool: ${call.function?.name}`;
            else if (!shellAdvertised) output = "tool denied by provider capability policy";
            else {
              let admittedInput = input;
              if (typeof options.canUseTool === 'function') {
                const verdict = await options.canUseTool('shell', input, { provider: 'openrouter', sessionId });
                if (!verdict || verdict.behavior !== 'allow') {
                  output = `tool denied: ${verdict?.message || 'caller policy'}`;
                } else if (verdict.updatedInput && typeof verdict.updatedInput === 'object') admittedInput = verdict.updatedInput;
              }
              if (output == null) output = await runShell(admittedInput, options.cwd || env.ATLAS_REPO || process.cwd(), env, options.abortSignal);
            }
            messages.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }
        // Loop exited by round-cap => exhaustion. Classified distinctly so the
        // station can one-shot-retry the run class (matches SDK error_max_turns).
        const namedCeiling = turnCap === configuredDefault ? configuredDefault : MAX_ROUNDS;
        yield { type: "result", subtype: "error_max_turns", result: `Run exhausted its ${turnCap}-tool-round bound (provider ceiling ${namedCeiling})`, total_cost_usd: null };
      } catch (error) {
        yield { type: "result", subtype: "error", result: safeError(error), total_cost_usd: null };
      }
    },
  };
}
