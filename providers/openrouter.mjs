import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "stealth/ox-alpha";
const MAX_ROUNDS = 24;
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

async function request(messages, env, signal) {
  const requestTimeout = Math.min(1_200_000, Math.max(1_000, Number(env.ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS) || 300_000));
  const timeoutSignal = AbortSignal.timeout(requestTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(API_URL, {
    method: "POST",
    signal: requestSignal,
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/NexumCorpus/atlas-station",
      "X-Title": "Atlas Station",
    },
    body: JSON.stringify({
      model: env.ATLAS_OPENROUTER_MODEL || env.ATLAS_CODEX_MODEL || DEFAULT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      reasoning: { effort: env.ATLAS_OPENROUTER_REASONING || "max" },
      max_tokens: Number(env.ATLAS_OPENROUTER_MAX_TOKENS) || 32_768,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || response.statusText || "OpenRouter request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function createOpenRouterProvider({ env = process.env } = {}) {
  const model = env.ATLAS_OPENROUTER_MODEL || env.ATLAS_CODEX_MODEL || DEFAULT_MODEL;
  return {
    name: "openrouter",
    assign() { return { purpose: "organism", route: "openrouter", model, source: "openrouter-directive" }; },
    probe() { return { available: Boolean(env.OPENROUTER_API_KEY), credentialConfigured: Boolean(env.OPENROUTER_API_KEY), model, api: "chat-completions" }; },
    async *query({ prompt, options = {} } = {}) {
      if (!env.OPENROUTER_API_KEY) {
        yield { type: "result", subtype: "error", result: "OPENROUTER_API_KEY is not configured", total_cost_usd: null };
        return;
      }
      const sessionId = options.resume && sessions.has(options.resume) ? options.resume : `openrouter:${randomUUID()}`;
      const messages = sessions.get(sessionId) || [{ role: "system", content: systemPrompt(options) }];
      messages.push({ role: "user", content: String(prompt || "") });
      sessions.set(sessionId, messages);
      yield { type: "system", subtype: "init", session_id: sessionId };
      options.onProviderSpawn?.({ pid: process.pid, startIdentity: `${process.pid}:${providerStartedAt}`, providerSessionId: sessionId, providerModel: model, provider: "openrouter" });
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const payload = await request(messages, env, options.abortSignal);
          const message = payload?.choices?.[0]?.message;
          if (!message) throw new Error("OpenRouter returned no assistant message");
          messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls || undefined });
          if (message.content) yield { type: "assistant", message: { content: [{ type: "text", text: String(message.content) }] } };
          const calls = message.tool_calls || [];
          if (!calls.length) {
            yield { type: "result", subtype: "success", result: String(message.content || ""), total_cost_usd: payload?.usage?.cost ?? 0, usage: payload.usage || null };
            return;
          }
          for (const call of calls) {
            let input = {};
            try { input = JSON.parse(call.function?.arguments || "{}"); } catch {}
            yield { type: "assistant", message: { content: [{ type: "tool_use", name: call.function?.name || "shell", input }] } };
            const output = call.function?.name === "shell"
              ? await runShell(input, options.cwd || env.ATLAS_REPO || process.cwd(), env, options.abortSignal)
              : `unsupported tool: ${call.function?.name}`;
            messages.push({ role: "tool", tool_call_id: call.id, content: output });
          }
        }
        yield { type: "result", subtype: "error", result: `OpenRouter exceeded ${MAX_ROUNDS} tool rounds`, total_cost_usd: null };
      } catch (error) {
        yield { type: "result", subtype: "error", result: safeError(error), total_cost_usd: null };
      }
    },
  };
}
