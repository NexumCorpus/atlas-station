// Fleet engine (plain-Node sidecar). Runs N AUTONOMOUS Claude agents
// concurrently via the Agent SDK, each emitting real state over IPC.
//
// Two dispatch modes:
//   read  — the read-only gate (Read/Glob/Grep/Web/Todo/Task). Safe surveys.
//   build — an ISOLATED git worktree on its own branch (fleet/<id>) with full
//           tool access (bypassPermissions). The agent writes + commits real
//           code; it CANNOT touch the user's main tree. The branch is the
//           deliverable, reviewed and merged by the overseer. This is how the
//           orchestrator does immense work — including on itself — safely.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import path from "path";

const REPO = process.env.ATLAS_REPO || "E:\\atlas-station";
const WT_BASE = process.env.ATLAS_WT || "E:\\atlas-wt";
const MODEL = process.env.ATLAS_MODEL || "claude-sonnet-4-6"; // dispatch Sonnet by default
const SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead"]);

const agents = new Map();
function send(type, payload) { if (process.send) process.send({ type, ...payload }); }
function set(id, patch) {
  const a = agents.get(id) || { id };
  Object.assign(a, patch);
  agents.set(id, a);
  send("agent", a);
}

function gitC(args) { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }

function makeWorktree(id) {
  const dir = path.join(WT_BASE, id);
  const branch = "fleet/" + id;
  mkdirSync(WT_BASE, { recursive: true });
  try { gitC(["worktree", "remove", "--force", dir]); } catch (_) {}
  try { gitC(["branch", "-D", branch]); } catch (_) {}
  gitC(["worktree", "add", "-f", "-b", branch, dir, "HEAD"]);
  return { dir, branch };
}

function branchStat(branch) {
  try {
    const stat = gitC(["diff", "--shortstat", "master.." + branch]).trim();
    const commits = Number(gitC(["rev-list", "--count", "master.." + branch]).trim()) || 0;
    return { branchStat: stat || "no diff yet", commits };
  } catch (_) { return { branchStat: "?", commits: 0 }; }
}

const BUILD_NOTE = "\n\n[Working conditions] You are inside an ISOLATED git worktree on your own branch — your changes cannot affect the user's main tree until they review and merge. Keep scope tight: do exactly this task, nothing extra. When the code is written and sanity-checked, COMMIT it (git add -A && git commit -m \"...\"). Do not push, do not touch other branches.";

async function runAgent(id, task, opts) {
  opts = opts || {};
  const build = opts.mode === "build";
  let cwd = opts.cwd || REPO, branch = null;
  set(id, { state: "working", task, mode: build ? "build" : "read", cwd, branch: null, lastTool: null, cost: null, summary: "", turns: 0 });
  if (build) {
    try { const wt = makeWorktree(id); cwd = wt.dir; branch = wt.branch; set(id, { cwd, branch }); }
    catch (e) { set(id, { state: "failed", summary: "worktree failed: " + String(e.message || e).slice(0, 150) }); return; }
  }
  try {
    for await (const m of query({
      prompt: build ? (task + BUILD_NOTE) : task,
      options: {
        cwd,
        model: MODEL,
        systemPrompt: "claude_code",
        ...(build
          ? { permissionMode: "bypassPermissions" }
          // The memory door: allow MUST carry updatedInput or the SDK throws a
          // ZodError on out-of-cwd reads (e.g. the journal under ~/.claude).
          : { canUseTool: async (name, input) => SAFE.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "read-only" } }),
      },
    })) {
      if (m.type === "system" && m.subtype === "init") set(id, { session: m.session_id });
      else if (m.type === "assistant") {
        const a = agents.get(id); const turns = (a.turns || 0) + 1;
        let patch = { state: "working", turns };
        for (const b of (m.message?.content ?? [])) {
          if (b.type === "tool_use") patch.lastTool = b.name;
          else if (b.type === "text" && b.text.trim()) patch.summary = b.text.trim().slice(0, 160);
        }
        set(id, patch);
      } else if (m.type === "result") {
        const done = m.subtype === "success";
        const extra = (build && branch) ? branchStat(branch) : {};
        set(id, { state: done ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: (m.result ?? agents.get(id)?.summary ?? "").slice(0, 220), ...extra });
      }
    }
  } catch (e) {
    set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) });
  }
}

process.on("message", (m) => {
  if (!m) return;
  if (m.t === "dispatch") runAgent(m.id, m.task, { mode: m.mode, cwd: m.cwd });
});

send("ready", {});
