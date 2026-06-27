// Fleet engine (plain-Node sidecar). Runs N AUTONOMOUS Claude agents
// concurrently via the Agent SDK, each on its own task + cwd (worktree), and
// emits their REAL state to the Electron parent over IPC. This is what makes
// the harness real: the brood = live agents, the eye = aggregate state, the
// opened egg = the agent that actually needs you.
import { query } from "@anthropic-ai/claude-agent-sdk";

// MVP gate: auto-allow read-only tools so agents run autonomously without
// hanging. Write/exec will route to a human-approval round-trip (the opened
// egg) once the UI is wired — for now they're denied so the fleet is safe.
const SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead"]);

const agents = new Map(); // id -> state record

function send(type, payload) { if (process.send) process.send({ type, ...payload }); }
function set(id, patch) {
  const a = agents.get(id) || { id };
  Object.assign(a, patch);
  agents.set(id, a);
  send("agent", a);
}

async function runAgent(id, task, cwd) {
  set(id, { state: "working", task, cwd, lastTool: null, cost: null, summary: "", turns: 0, session: null });
  try {
    for await (const m of query({
      prompt: task,
      options: {
        cwd: cwd || process.env.ATLAS_CWD || "E:\\",
        systemPrompt: "claude_code",
        canUseTool: async (name) => SAFE.has(name)
          ? { behavior: "allow" }
          : { behavior: "deny", message: "fleet MVP: read-only until the approval panel" },
      },
    })) {
      if (m.type === "system" && m.subtype === "init") {
        set(id, { session: m.session_id });
      } else if (m.type === "assistant") {
        const a = agents.get(id); const turns = (a.turns || 0) + 1;
        let patch = { state: "working", turns };
        for (const b of (m.message?.content ?? [])) {
          if (b.type === "tool_use") patch.lastTool = b.name;
          else if (b.type === "text" && b.text.trim()) patch.summary = b.text.trim().slice(0, 160);
        }
        set(id, patch);
      } else if (m.type === "result") {
        set(id, {
          state: m.subtype === "success" ? "done" : "failed",
          cost: m.total_cost_usd ?? null,
          summary: (m.result ?? agents.get(id)?.summary ?? "").slice(0, 220),
        });
      }
    }
  } catch (e) {
    set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) });
  }
}

process.on("message", (m) => {
  if (!m) return;
  if (m.t === "dispatch") runAgent(m.id, m.task, m.cwd);
  // future: m.t === "decision" for the human-approval round-trip
});

send("ready", {});
