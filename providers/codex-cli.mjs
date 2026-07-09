import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MAX_DIAGNOSTIC_CHARS = 1_200;

function truncate(value, limit = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value || "").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/**
 * Resolve the Codex CLI without embedding a machine-specific package version.
 * `ATLAS_CODEX_BIN` is always preferred for installations outside Codex Desktop.
 */
export function resolveCodexBinary(env = process.env) {
  if (env.ATLAS_CODEX_BIN) return env.ATLAS_CODEX_BIN;

  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const version of versions) {
        const candidate = join(root, version, process.platform === "win32" ? "codex.exe" : "codex");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Fall through to PATH. A missing Desktop installation is not exceptional.
    }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function resolveCodexSandbox(options = {}, env = process.env) {
  if (options.atlasMode === "build") {
    return env.ATLAS_CODEX_BUILD_SANDBOX || "workspace-write";
  }
  if (options.atlasMode === "orchestrator") {
    return env.ATLAS_CODEX_ORCHESTRATOR_SANDBOX || "read-only";
  }
  return env.ATLAS_CODEX_READ_SANDBOX || "read-only";
}

/** A session id only has meaning to the provider that issued it. */
export function compatibleSession(sessionId, sessionProvider, activeProvider) {
  return typeof sessionId === "string" && sessionId && sessionProvider === activeProvider
    ? sessionId
    : null;
}

/**
 * The Claude SDK's in-process MCP server cannot be injected into an external
 * Codex process. Make that boundary explicit instead of encouraging a model to
 * claim it called fleet tools that are not attached.
 */
export function buildCodexPrompt(prompt, options = {}) {
  const mode = options.atlasMode || "read";
  const supplemental = typeof options.systemPrompt === "string" && options.systemPrompt !== "claude_code"
    ? ["", "Supplemental ATLAS instructions (use only where compatible with the provider boundary):", options.systemPrompt]
    : [];
  return [
    "You are executing as ATLAS's Codex CLI provider.",
    `ATLAS mode: ${mode}.`,
    "The Claude Agent SDK and ATLAS in-process fleet MCP tools are not attached to this process.",
    "Do not claim to call fleet tools such as spawn_agent, verify_build, or shard_memory.",
    "Use only the current workspace and standard local tools that Codex actually exposes.",
    "Do not push, publish, or make external changes.",
    "Return a concise final report with concrete evidence and any blocker.",
    "",
    "Task:",
    String(prompt || ""),
    ...supplemental,
  ].join("\n");
}

export function buildCodexCommand({ prompt, options = {}, env = process.env, command } = {}) {
  const binary = command || resolveCodexBinary(env);
  const preparedPrompt = buildCodexPrompt(prompt, options);
  const useUserConfig = env.ATLAS_CODEX_USE_USER_CONFIG === "1";
  const model = env.ATLAS_CODEX_MODEL;

  if (options.resume) {
    const args = ["exec", "resume", "--json"];
    if (!useUserConfig) args.push("--ignore-user-config");
    if (model) args.push("--model", model);
    args.push(String(options.resume), preparedPrompt);
    return { binary, args, cwd: options.cwd || env.ATLAS_REPO || process.cwd() };
  }

  const args = ["exec", "--json", "--color", "never"];
  if (!useUserConfig) args.push("--ignore-user-config");
  if (model) args.push("--model", model);
  args.push("-C", options.cwd || env.ATLAS_REPO || process.cwd());
  args.push("-s", resolveCodexSandbox(options, env));
  args.push(preparedPrompt);
  return { binary, args, cwd: options.cwd || env.ATLAS_REPO || process.cwd() };
}

/** Translate Codex exec JSONL into the small event shape fleethost already uses. */
export function normalizeCodexEvent(event, state = {}) {
  if (!event || typeof event !== "object") return [];

  if (event.type === "thread.started" && event.thread_id) {
    return [{ type: "system", subtype: "init", session_id: event.thread_id }];
  }

  if (event.type === "item.started" || event.type === "item.completed") {
    const item = event.item || {};
    if (item.type === "agent_message" && item.text) {
      state.lastText = String(item.text);
      return [{ type: "assistant", message: { content: [{ type: "text", text: state.lastText }] } }];
    }
    if (item.type === "command_execution") {
      const command = item.command || item.input || "";
      return [{ type: "assistant", message: { content: [{
        type: "tool_use", name: "Bash", input: { command: String(command) },
      }] } }];
    }
  }

  if (event.type === "turn.completed") {
    state.terminal = true;
    return [{
      type: "result",
      subtype: "success",
      result: state.lastText || "",
      total_cost_usd: null,
      usage: event.usage || null,
    }];
  }

  if (event.type === "turn.failed" || event.type === "error") {
    state.terminal = true;
    const detail = event.error?.message || event.message || event.error || "Codex turn failed";
    return [{ type: "result", subtype: "error", result: truncate(detail), total_cost_usd: null }];
  }

  return [];
}

export async function* codexCliQuery({ prompt, options = {} } = {}, config = {}) {
  const env = config.env || process.env;
  const spec = buildCodexCommand({ prompt, options, env, command: config.command });
  const state = { lastText: "", terminal: false };
  let stderr = "";
  let spawnError = null;
  let aborted = false;
  let child;

  try {
    child = spawn(spec.binary, spec.args, {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    yield { type: "result", subtype: "error", result: truncate(error.message), total_cost_usd: null };
    return;
  }

  const closed = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  const abort = () => {
    aborted = true;
    try { child.kill(); } catch { /* process already ended */ }
  };
  options.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      for (const translated of normalizeCodexEvent(event, state)) yield translated;
    }
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
  }

  const exit = await closed;
  if (!state.terminal) {
    const detail = aborted
      ? "Codex execution cancelled"
      : spawnError?.message || stderr || `Codex exited before completing (code=${exit.code}, signal=${exit.signal || "none"})`;
    yield { type: "result", subtype: "error", result: truncate(detail), total_cost_usd: null };
  }
}

export function createCodexCliProvider({ env = process.env, command } = {}) {
  const binary = command || resolveCodexBinary(env);
  return {
    name: "codex-cli",
    query(args) { return codexCliQuery(args, { env, command: binary }); },
    probe() {
      const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
      if (result.error || result.status !== 0) {
        return { available: false, binary, error: truncate(result.error?.message || result.stderr || "Codex CLI probe failed") };
      }
      return { available: true, binary, version: String(result.stdout || "").trim() };
    },
  };
}
