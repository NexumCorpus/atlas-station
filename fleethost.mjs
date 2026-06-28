// Fleet engine (plain-Node sidecar). Runs N AUTONOMOUS Claude agents
// concurrently via the Agent SDK, each emitting real state over IPC.
//
//   read  — read-only gate (Read/Glob/Grep/Web/Todo/Task). Safe surveys + chat.
//   build — an ISOLATED git worktree on its own branch (fleet/<id>) with full
//           tool access (bypassPermissions). The branch is the deliverable.
//
// Each agent is also a CONVERSATION: its SDK session is remembered, so the
// overseer can reply into it (resume) and the agent continues — not a new agent.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

// Derive __dirname for this ESM module so we can locate sibling CJS modules.
const __agentDir = path.dirname(fileURLToPath(import.meta.url));
const persist = _require("./persist.cjs");
const AGENTS_FILE = path.join(__agentDir, "fleet-agents.json");

// Persist the full agents map atomically.  Fail-open: a write error must never
// crash the fleet or block the agent loop.
function persistAll() {
  try { persist.saveAgents(Array.from(agents.values()), AGENTS_FILE); } catch (_) {}
}

const REPO = process.env.ATLAS_REPO || "E:\\atlas-station";
const WT_BASE = process.env.ATLAS_WT || "E:\\atlas-wt";
const MODEL = process.env.ATLAS_MODEL || "claude-sonnet-4-6"; // dispatch Sonnet by default
const SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead"]);

// Memory modules — loaded at startup; if absent/broken, dispatch falls through.
let _memcontext = null, _memstore = null;
try { _memcontext = _require("./memcontext.cjs"); } catch { _memcontext = null; }
try { _memstore = _require("./memstore.cjs"); } catch { _memstore = null; }

const agents = new Map();
function send(type, payload) { if (process.send) process.send({ type, ...payload }); }
function set(id, patch) {
  const a = agents.get(id) || { id };
  Object.assign(a, patch);
  a.ts = new Date().toISOString();
  agents.set(id, a);
  send("agent", a);
  persistAll();
}

function gitC(args) { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
function makeWorktree(id) {
  const dir = path.join(WT_BASE, id); const branch = "fleet/" + id;
  mkdirSync(WT_BASE, { recursive: true });
  try { gitC(["worktree", "remove", "--force", dir]); } catch (_) {}
  try { gitC(["branch", "-D", branch]); } catch (_) {}
  gitC(["worktree", "add", "-f", "-b", branch, dir, "HEAD"]);
  return { dir, branch };
}
function branchStat(branch) {
  try { const stat = gitC(["diff", "--shortstat", "master.." + branch]).trim(); const commits = Number(gitC(["rev-list", "--count", "master.." + branch]).trim()) || 0; return { branchStat: stat || "no diff yet", commits }; }
  catch (_) { return { branchStat: "?", commits: 0 }; }
}

// allow MUST carry updatedInput or the SDK throws a ZodError on out-of-cwd reads.
const readGate = async (name, input) => SAFE.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "read-only" };
const BUILD_NOTE = "\n\n[Working conditions] You are inside an ISOLATED git worktree on your own branch — your changes cannot affect the user's main tree until they review and merge. Keep scope tight: do exactly this task, nothing extra. When the code is written and sanity-checked, COMMIT it (git add -A && git commit -m \"...\"). Do not push, do not touch other branches.";

// Stream one query's messages into agent `id`'s live state.
async function consume(id, iterable, build, branch) {
  for await (const m of iterable) {
    if (m.type === "system" && m.subtype === "init") set(id, { session: m.session_id });
    else if (m.type === "assistant") {
      const a = agents.get(id); const turns = (a?.turns || 0) + 1; let patch = { state: "working", turns };
      for (const b of (m.message?.content ?? [])) {
        if (b.type === "tool_use") patch.lastTool = b.name;
        else if (b.type === "text" && b.text.trim()) patch.summary = b.text.trim().slice(0, 160);
      }
      set(id, patch);
    } else if (m.type === "result") {
      const done = m.subtype === "success"; const extra = (build && branch) ? branchStat(branch) : {};
      const full = String(m.result ?? agents.get(id)?.summary ?? "");
      set(id, { state: done ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: full.slice(0, 220), reply: full.slice(0, 8000), ...extra });
      if (_memstore) try { _memstore.appendRun({ agentId: id, task: agents.get(id)?.task, mode: build ? "build" : "read", state: done ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: full.slice(0, 500), branch: branch ?? null, transcriptPath: null }); } catch {}
    }
  }
}

async function runAgent(id, task, opts) {
  opts = opts || {}; const build = opts.mode === "build"; let cwd = opts.cwd || REPO, branch = null;
  set(id, { state: "working", task, mode: build ? "build" : "read", cwd, branch: null, lastTool: null, cost: null, summary: "", reply: "", turns: 0, session: null });
  const enrichedTask = _memcontext ? _memcontext.inject(task) : task;
  if (build) {
    try { const wt = makeWorktree(id); cwd = wt.dir; branch = wt.branch; set(id, { cwd, branch }); }
    catch (e) { set(id, { state: "failed", summary: "worktree failed: " + String(e.message || e).slice(0, 150) }); return; }
  }
  const options = { cwd, model: MODEL, systemPrompt: "claude_code", ...(build ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  try { await consume(id, query({ prompt: build ? (enrichedTask + BUILD_NOTE) : enrichedTask, options }), build, branch); }
  catch (e) { set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) }); }
}

// Continue an existing agent's conversation by resuming its SDK session.
async function replyAgent(id, text) {
  const a = agents.get(id);
  if (!a || !a.session) { if (a) set(id, { state: "failed", summary: "cannot continue: session not ready" }); return; }
  const build = a.mode === "build"; const cwd = a.cwd || REPO; const branch = a.branch || null;
  set(id, { state: "working", lastTool: null });
  const options = { resume: a.session, cwd, model: MODEL, systemPrompt: "claude_code", ...(build ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  try { await consume(id, query({ prompt: text, options }), build, branch); }
  catch (e) { set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) }); }
}

process.on("message", (m) => {
  if (!m) return;
  if (m.t === "dispatch") runAgent(m.id, m.task, { mode: m.mode, cwd: m.cwd });
  else if (m.t === "reply") replyAgent(m.id, m.text);
});

send("ready", {});

// Restore persisted agents from a prior session.  Populate the in-memory map
// FIRST so replyAgent() can resume any of them immediately after this message.
// Fail-open: a corrupt file must not prevent the fleet from starting.
try {
  const saved = persist.loadAgents(AGENTS_FILE);
  if (saved && saved.length) {
    for (const a of saved) agents.set(a.id, a);
    send("restored", { agents: saved });
  }
} catch (_) {}

// History for the window — real git build log + any recorded runs.
try {
  const commits = gitC(["log", "--pretty=%h\x1f%s\x1f%cr", "-40"]).trim().split("\n").filter(Boolean).map((l) => { const p = l.split("\x1f"); return { sha: p[0], subject: p[1] || "", when: p[2] || "" }; });
  const runs = (_memstore && _memstore.recentRuns) ? _memstore.recentRuns(50) : [];
  send("history", { commits, runs });
} catch (_) {}
