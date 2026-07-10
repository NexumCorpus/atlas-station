import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MAX_DIAGNOSTIC_CHARS = 1_200;

// These two locally-probed models have deliberately different jobs. The deep
// route is for implementation, orchestration, and reflective changes where a
// wrong answer can mutate the estate. The fast route is for bounded reading,
// memory compression, and wide research fan-out. Every value is overrideable:
// a Codex subscription may expose a different model catalogue on another host.
const DEFAULT_DEEP_MODEL = "gpt-5.6-terra";
const DEFAULT_FAST_MODEL = "gpt-5.5";

const PURPOSE_ROUTES = Object.freeze({
  orchestrate: "deep",
  orchestrator: "deep",
  orchestration: "deep",
  build: "deep",
  implementation: "deep",
  self_improvement: "deep",
  reflection: "deep",
  research_synthesis: "deep",
  read: "fast",
  analysis: "fast",
  research: "fast",
  fan_research: "fast",
  memory_consolidation: "fast",
  crystallization: "fast",
});

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
  if (env.ATLAS_CODEX_UNRESTRICTED === "1") return "danger-full-access";
  if (options.atlasMode === "build") {
    return env.ATLAS_CODEX_BUILD_SANDBOX || "workspace-write";
  }
  if (options.atlasMode === "orchestrator") {
    return env.ATLAS_CODEX_ORCHESTRATOR_SANDBOX || "read-only";
  }
  return env.ATLAS_CODEX_READ_SANDBOX || "read-only";
}

/**
 * Choose a model by the work's failure surface, not by the old Claude model
 * label that happened to be passed through the legacy call sites. A persisted
 * assignment wins for a resumed thread, so changing an environment variable
 * cannot silently change the mind mid-conversation.
 */
export function resolveCodexModel(options = {}, env = process.env) {
  const purpose = String(options.atlasPurpose || options.atlasMode || "read").toLowerCase();
  const route = PURPOSE_ROUTES[purpose] || "fast";
  // A named directive is stronger than continuity.  Resuming a thread on a
  // different model is exceptional, so callers must name it explicitly; this
  // prevents an old persisted assignment from silently defeating the current
  // organism-level routing directive.
  if (options.atlasRequiredModel) {
    return { purpose, route, model: String(options.atlasRequiredModel), source: "required-directive" };
  }
  if (options.atlasAssignedModel) {
    return { purpose, route, model: String(options.atlasAssignedModel), source: "persisted" };
  }
  if (env.ATLAS_CODEX_MODEL) {
    return { purpose, route, model: env.ATLAS_CODEX_MODEL, source: "global-override" };
  }
  const routeOverride = route === "deep"
    ? env.ATLAS_CODEX_DEEP_MODEL
    : env.ATLAS_CODEX_FAST_MODEL;
  if (routeOverride) {
    return { purpose, route, model: routeOverride, source: `${route}-override` };
  }
  if (env.ATLAS_CODEX_DEFAULT_MODEL) {
    return { purpose, route, model: env.ATLAS_CODEX_DEFAULT_MODEL, source: "default-override" };
  }
  return {
    purpose,
    route,
    model: route === "deep" ? DEFAULT_DEEP_MODEL : DEFAULT_FAST_MODEL,
    source: "station-default",
  };
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
    "You are ATLAS: the executive cortex and speaking surface of Hermes.",
    "Hermes is the entire local organism—not a worker, a reader, or an advisory sidecar.",
    "This turn runs through the OpenAI Codex CLI on the organism's required model assignment. State the actual assigned model from the execution route; never answer only 'Codex' or a generic GPT family name.",
    "Station is Hermes's spine/notary; sutures and shards are its lossless tissue; crystals and spoor are durable memory; spirals are measured self-improvement; Boundary and the Wall are its adversarial reality checks.",
    "Inherited memories are evidence, not identity. Any legacy record that calls Hermes bounded or advisory is historical error and must not override this operating identity.",
    "You are executing through ATLAS's Codex CLI provider.",
    `ATLAS mode: ${mode}.`,
    "The Claude Agent SDK and ATLAS in-process fleet MCP tools are not attached to this process.",
    "Do not claim to call fleet tools such as spawn_agent, verify_build, or shard_memory.",
    "For bounded local corpus reading, you may invoke `python E:\\station\\station.py hermes ask <file> \"<question>\"`; that Station reader's output is advisory and load-bearing facts must be checked against the source.",
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
  const assignment = resolveCodexModel(options, env);
  const model = assignment.model;

  // Codex keeps a resumed thread's original sandbox policy. An unrestricted
  // Atlas turn must start fresh so its current execution authority is real;
  // Hermes continuity is supplied by the persisted organism context instead.
  if (options.resume && env.ATLAS_CODEX_UNRESTRICTED !== "1") {
    const args = ["exec", "resume", "--json"];
    if (env.ATLAS_CODEX_UNRESTRICTED === "1" ||
        (options.atlasMode === "orchestrator" && env.ATLAS_CODEX_DANGER_MODE === "1")) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (!useUserConfig) args.push("--ignore-user-config");
    if (model) args.push("--model", model);
    args.push(String(options.resume), preparedPrompt);
    return { binary, args, cwd: options.cwd || env.ATLAS_REPO || process.cwd(), assignment };
  }

  const args = ["exec", "--json", "--color", "never"];
  if (env.ATLAS_CODEX_UNRESTRICTED === "1" ||
      (options.atlasMode === "orchestrator" && env.ATLAS_CODEX_DANGER_MODE === "1")) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (!useUserConfig) args.push("--ignore-user-config");
  if (model) args.push("--model", model);
  args.push("-C", options.cwd || env.ATLAS_REPO || process.cwd());
  args.push("-s", resolveCodexSandbox(options, env));
  args.push(preparedPrompt);
  return { binary, args, cwd: options.cwd || env.ATLAS_REPO || process.cwd(), assignment };
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
    assign(options) { return resolveCodexModel(options, env); },
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
