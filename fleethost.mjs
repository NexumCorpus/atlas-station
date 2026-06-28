// Fleet engine (plain-Node sidecar) — ORCHESTRATOR model.
//
// The user talks ONLY to ATLAS, the orchestrator. ATLAS holds a `fleet` tool
// server (spawn_agent / check_fleet) and dispatches + manages subagents itself;
// the user never addresses a subagent. Subagents appear in the brood as
// read-only oversight. read = read-only gate; build = isolated git worktree.
//
// Agents are durable (persisted + restored on restart) and conversational
// (sessions resume). ATLAS is gated to read + delegation: to change anything it
// MUST spawn a build subagent (isolated worktree), never the live tree.
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import path from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

const REPO = process.env.ATLAS_REPO || "E:\\atlas-station";
const WT_BASE = process.env.ATLAS_WT || "E:\\atlas-wt";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = process.env.ATLAS_MODEL || "claude-sonnet-4-6";
const MODEL_OPUS   = "claude-opus-4-8";
const MODEL = MODEL_SONNET; // default for ATLAS orchestrator
const SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead"]);
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function extractToolArg(name, input) {
  if (!input) return null;
  if (name === "Read") return (input.file_path || "").split(/[/\\]/).pop().slice(0, 40) || null;
  if (name === "Bash") return (input.command || "").slice(0, 50) || null;
  if (name === "Grep") return (input.pattern || "").slice(0, 30) || null;
  if (name === "Glob") return (input.pattern || "").slice(0, 30) || null;
  if (name === "WebFetch" || name === "WebSearch") return (input.url || input.query || "").slice(0, 40) || null;
  if (name === "spawn_agent") return ("spawning: " + (input.task || "").slice(0, 40));
  return null;
}

let _memcontext = null, _memstore = null, _persist = null, _session = null, _goals = null;
try { _memcontext = _require("./memcontext.cjs"); } catch { _memcontext = null; }
try { _memstore = _require("./memstore.cjs"); } catch { _memstore = null; }
try { _persist = _require("./persist.cjs"); } catch { _persist = null; }
try { _session = _require("./session-narrative.cjs"); } catch { _session = null; }
try { _goals = _require("./goal-store.cjs"); } catch { _goals = null; }
let _deferred = null;
try { _deferred = _require('./deferred.cjs'); } catch { _deferred = null; }
let _notif = null;
try { _notif = _require('./notifications.cjs'); } catch { _notif = null; }
let _selfloop = null;
try { _selfloop = _require('./selfloop.cjs'); } catch { _selfloop = null; }

const agents = new Map();
const abortControllers = new Map();
const timeoutHandles = new Map(); // setTimeout handles kept OUT of agent records (Timeout is circular → would crash IPC/JSON serialize)
let _maxCounter = 0;     // subagent numbering (persisted)
let orchSession = null;  // ATLAS conversation session (persisted, resumes on restart)
const sessionStats = { startTs: new Date().toISOString(), agentCount: 0, totalCost: 0, topics: [] };

function send(type, payload) { if (process.send) process.send({ type, ...payload }); }
function pruneAgent(id) {
  const a = agents.get(id);
  if (!a || !a.branch || !a.cwd) return;
  try {
    // Only prune if branch is merged to master
    gitC(["merge-base", "--is-ancestor", a.branch, "master"]);
    // Branch is merged — remove worktree then branch
    try { gitC(["worktree", "remove", "--force", a.cwd]); } catch (_) {}
    try { gitC(["branch", "-d", a.branch]); } catch (_) { try { gitC(["branch", "-D", a.branch]); } catch (_) {} }
  } catch (_) {
    // Not merged yet — leave it
  }
}

function set(id, patch) {
  const a = agents.get(id) || { id };
  // Clear timeout before transitioning to a terminal state
  if ((patch.state === "done" || patch.state === "failed") && timeoutHandles.has(id)) {
    clearTimeout(timeoutHandles.get(id));
    timeoutHandles.delete(id);
  }
  // Accumulate subagent costs for session narrative
  if ((patch.state === "done" || patch.state === "failed") && patch.cost != null && id !== "ATLAS") {
    sessionStats.totalCost += Number(patch.cost) || 0;
  }
  Object.assign(a, patch);
  if (a.timeoutHandle) delete a.timeoutHandle; // strip any legacy/persisted handle field
  a.ts = new Date().toISOString();
  agents.set(id, a);
  // Start timeout when first entering working state. The handle lives in
  // timeoutHandles (a side map), NEVER on the agent record — a Timeout object is
  // circular and would throw "Converting circular structure to JSON" on send/persist.
  if (patch.state === "working" && !timeoutHandles.has(id)) {
    const ms = a.timeoutMs != null ? a.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (ms > 0) {
      timeoutHandles.set(id, setTimeout(() => {
        const ctrl = abortControllers.get(id);
        if (ctrl) ctrl.abort();
        set(id, { state: "failed", summary: "timeout — agent exceeded " + Math.round(ms / 60000) + "min limit" });
      }, ms));
    }
  }
  send("agent", a);
  // Emit running session cost update to GUI
  if (patch.state === 'done' || patch.state === 'failed') {
    const runningCost = [...agents.values()].reduce((s, ag) => s + (Number(ag.cost) || 0), 0);
    send('session_cost', { total: runningCost, agentCount: sessionStats.agentCount });
  }
  if (_persist) { try { _persist.save({ agents: [...agents.values()], maxCounter: _maxCounter, orchSession }); } catch {} }
  if ((patch.state === "done" || patch.state === "failed") && id !== "ATLAS") {
    const cur = agents.get(id);
    if (cur && cur.branch && cur.mode === "build") {
      setTimeout(() => pruneAgent(id), 5000);
    }
  }
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

const readGate = async (name, input) => SAFE.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "read-only" };
const BUILD_NOTE = "\n\n[Working conditions] You are inside an ISOLATED git worktree which IS your current working directory. Edit files only here, via RELATIVE paths; never touch absolute E:\\atlas-station or anything outside this worktree. Keep scope tight, sanity-check, then COMMIT (git add -A && git commit -m \"...\"). Do not push.";

// Stream one query's messages into agent `id`'s state; returns the final reply.
async function consume(id, iterable, build, branch) {
  let final = "";
  for await (const m of iterable) {
    if (m.type === "system" && m.subtype === "init") set(id, { session: m.session_id });
    else if (m.type === "assistant") {
      const a = agents.get(id); const turns = (a?.turns || 0) + 1; let patch = { state: "working", turns };
      for (const b of (m.message?.content ?? [])) {
        if (b.type === "tool_use") {
          const n = (b.name || "").replace(/^mcp__fleet__/, "");
          patch.lastTool = n;
          patch.lastToolArg = extractToolArg(n, b.input);
        }
        else if (b.type === "text" && b.text.trim()) {
          patch.summary = b.text.trim().slice(0, 160);
          // Stream partial text to GUI in real-time (no persist, no agents Map mutation)
          const cur = agents.get(id) || { id };
          send("agent", { ...cur, ...patch, partial: true, ts: new Date().toISOString() });
        }
      }
      set(id, patch);
    } else if (m.type === "result") {
      const done = m.subtype === "success"; const extra = (build && branch) ? branchStat(branch) : {};
      final = String(m.result ?? agents.get(id)?.summary ?? "");
      set(id, { state: done ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: final.slice(0, 220), reply: final.slice(0, 8000), lastToolArg: null, ...extra });
      if (_memstore) try { _memstore.appendRun({ agentId: id, task: agents.get(id)?.task, mode: build ? "build" : "read", state: done ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: final.slice(0, 500), branch: branch ?? null, transcriptPath: null }); } catch {}
    }
  }
  return final;
}

// A subagent ATLAS spawns. Returns its final reply (for the tool result).
async function runSubagent(task, mode, agentTimeout = DEFAULT_TIMEOUT_MS, model) {
  _maxCounter++; const id = (mode === "build" ? "B-" : "A-") + _maxCounter;
  sessionStats.agentCount++;
  const agentModel = model || (mode === 'read' ? MODEL_HAIKU : MODEL_SONNET);
  let cwd = REPO, branch = null;
  set(id, { state: "working", task, mode: mode === "build" ? "build" : "read", parent: "ATLAS", cwd, branch: null, lastTool: null, cost: null, summary: "", reply: "", turns: 0, session: null, timeoutMs: agentTimeout, timeoutHandle: null, model: agentModel });
  const enriched = _memcontext ? _memcontext.inject(task) : task;
  if (mode === "build") {
    try { const wt = makeWorktree(id); cwd = wt.dir; branch = wt.branch; set(id, { cwd, branch }); }
    catch (e) { set(id, { state: "failed", summary: "worktree failed: " + String(e.message || e).slice(0, 120) }); return "Subagent " + id + " could not start (worktree error)."; }
  }
  const options = { cwd, model: agentModel, systemPrompt: "claude_code", ...(mode === "build" ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  let final = "";
  const ac = new AbortController();
  abortControllers.set(id, ac);
  try {
    final = await consume(id, query({ prompt: mode === "build" ? (enriched + BUILD_NOTE) : enriched, options: { ...options, abortSignal: ac.signal } }), mode === "build", branch);
  } catch (e) {
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      set(id, { state: "interrupted", summary: "cancelled by user" });
      final = "(cancelled)";
    } else {
      set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) });
      final = "(subagent errored: " + String(e?.message ?? e).slice(0, 120) + ")";
    }
  } finally {
    abortControllers.delete(id);
  }
  return "Subagent " + id + (branch ? (" on branch " + branch) : "") + " result:\n" + (final || "(no output)");
}

// --- the fleet tools ATLAS holds ---
const spawnTool = tool(
  "spawn_agent",
  "Spawn a subagent to perform a task and get back its result. mode 'read' = read-only analysis/survey; mode 'build' = make changes (runs in an isolated git worktree on its own branch, reviewed before merge). Spawn several for parallel or staged work. model param: 'haiku' for quick reads (faster, cheaper), 'sonnet' default for builds, 'opus' for complex multi-step reasoning.",
  {
    task: z.string().describe("the complete, self-contained task for the subagent"),
    mode: z.enum(["read", "build"]).optional().describe("read (default) or build"),
    timeoutMinutes: z.number().optional().describe("Auto-cancel after N minutes (default 20). Set 0 to disable."),
    model: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier: haiku (fast/cheap reads), sonnet (default builds), opus (complex reasoning)"),
  },
  async (args) => {
    const agentTimeout = typeof args.timeoutMinutes === "number"
      ? (args.timeoutMinutes <= 0 ? 0 : args.timeoutMinutes * 60 * 1000)
      : DEFAULT_TIMEOUT_MS;
    const modelMap = { haiku: MODEL_HAIKU, sonnet: MODEL_SONNET, opus: MODEL_OPUS };
    const model = modelMap[args.model] || undefined;
    return { content: [{ type: "text", text: await runSubagent(args.task, args.mode || "read", agentTimeout, model) }] };
  }
);
const checkTool = tool(
  "check_fleet",
  "List the current subagents and their states.",
  {},
  async () => { const rows = [...agents.values()].filter((a) => a.id !== "ATLAS").map((a) => `${a.id} [${a.state}] ${(a.task || "").slice(0, 60)}${a.branch ? " " + a.branch : ""}`); return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "no subagents yet" }] }; }
);
const chainTool = tool(
  "chain_agents",
  "Run a sequence of agents in order, each receiving the prior agent's result as context. Use for read→build→verify pipelines. Returns the final agent's result.",
  {
    steps: z.array(z.object({
      task: z.string().describe("task for this step"),
      mode: z.enum(["read", "build"]).optional().describe("read (default) or build"),
    })).describe("ordered list of agent steps"),
  },
  async (args) => {
    let context = "";
    const results = [];
    for (const step of (args.steps || [])) {
      const taskWithCtx = context ? step.task + "\n\n[Prior step result]\n" + context.slice(0, 4000) : step.task;
      const result = await runSubagent(taskWithCtx, step.mode || "read");
      context = result;
      results.push(result);
    }
    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  }
);
const statusTool = tool(
  "fleet_status",
  "Get detailed status of all agents including cost, turn count, branch, and elapsed time.",
  {},
  async () => {
    const now = Date.now();
    const rows = [...agents.values()].filter(a => a.id !== "ATLAS").map(a => {
      const elapsed = a.ts ? Math.round((now - new Date(a.ts).getTime()) / 1000) : null;
      const cost = a.cost != null ? ` $${a.cost.toFixed(3)}` : "";
      const branch = a.branch ? ` [${a.branch}]` : "";
      const turns = a.turns ? ` ${a.turns}t` : "";
      const time = elapsed != null ? ` ${elapsed}s ago` : "";
      return `${a.id} [${a.state}]${cost}${turns}${branch}${time} — ${(a.task || "").slice(0, 60)}`;
    });
    return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "no subagents" }] };
  }
);
const diagnoseTool = tool(
  "diagnose",
  "Run a self-check on the station: verify source files exist, check memory store health, report fleet summary. Use when something seems wrong.",
  {},
  async () => {
    const fs = _require('fs');
    const checks = [];
    // Check key source files
    const files = ['main.cjs', 'fleethost.mjs', 'index.html', 'preload.cjs', 'memcontext.cjs', 'memstore.cjs', 'prune.mjs'];
    for (const f of files) {
      const exists = fs.existsSync(path.join(REPO, f));
      checks.push((exists ? "✓" : "✗") + " " + f);
    }
    // Check memory dir
    const memDir = path.join(REPO, 'memory');
    checks.push(fs.existsSync(memDir) ? "✓ memory/" : "✗ memory/ (missing)");
    // Agent summary
    const all = [...agents.values()];
    const summary = all.length === 0 ? "no agents" :
      all.map(a => `${a.id}[${a.state}]`).join(", ");
    checks.push("fleet: " + summary);
    // Git status
    try {
      const branch = gitC(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const hash = gitC(["rev-parse", "--short", "HEAD"]).trim();
      checks.push("git: " + branch + "@" + hash);
    } catch (_) {
      checks.push("git: unavailable");
    }
    return { content: [{ type: "text", text: checks.join("\n") }] };
  }
);
const proposeTool = tool(
  "propose_improvement",
  "Queue a self-directed improvement proposal for Daniel to review. Use this when you identify something worth building or changing — even if Daniel hasn't asked for it. Proposals appear in the GUI.",
  {
    description: z.string().describe("What to build or change, and why"),
    priority: z.enum(["high", "medium", "low"]).optional().describe("Urgency level (default: medium)"),
    area: z.enum(["gui", "fleet", "memory", "autonomy", "other"]).optional().describe("Which part of the station"),
  },
  async (args) => {
    const proposal = {
      id: 'P-' + Date.now(),
      ts: new Date().toISOString(),
      description: args.description || '',
      priority: args.priority || 'medium',
      area: args.area || 'other',
      state: 'pending',
    };
    // Persist to disk
    try {
      const fs = _require('fs');
      const pfile = path.join(REPO, 'memory', 'proposals.ndjson');
      fs.appendFileSync(pfile, JSON.stringify(proposal) + '\n', 'utf8');
    } catch (_) {}
    // Broadcast to GUI
    send('proposal', proposal);
    return { content: [{ type: 'text', text: `Proposal queued: ${proposal.id} — "${proposal.description.slice(0, 80)}"` }] };
  }
);
const loadProposalsTool = tool(
  "load_proposals",
  "List pending self-improvement proposals. Use to review what's already been proposed before adding a duplicate.",
  {},
  async () => {
    try {
      const fs = _require('fs');
      const pfile = path.join(REPO, 'memory', 'proposals.ndjson');
      if (!fs.existsSync(pfile)) return { content: [{ type: 'text', text: 'no proposals yet' }] };
      const lines = fs.readFileSync(pfile, 'utf8').trim().split('\n').filter(Boolean);
      const proposals = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const pending = proposals.filter(p => p.state === 'pending');
      if (!pending.length) return { content: [{ type: 'text', text: 'no pending proposals' }] };
      const text = pending.map(p => `[${p.priority}] ${p.id}: ${p.description}`).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (_) {
      return { content: [{ type: 'text', text: 'could not load proposals' }] };
    }
  }
);
const journalWriteTool = tool(
  "journal_write",
  "Write an observation or insight to the persistent memory store. Use this to intentionally record something worth remembering across sessions — a discovery, a pattern you noticed, a decision and its rationale. This is ATLAS writing to its own memory.",
  {
    observation: z.string().describe("The fact or insight to record (1-3 sentences)"),
    topic: z.string().optional().describe("Topic tag, e.g. 'fleet', 'gui', 'memory', 'architecture'"),
    confidence: z.enum(["verified", "inferred", "tentative"]).optional().describe("Confidence level (default: inferred)"),
  },
  async (args) => {
    try {
      const fact = {
        topic: args.topic || 'general',
        fact: args.observation,
        source: `ATLAS:${new Date().toISOString().slice(0, 10)}`,
        confidence: args.confidence || 'inferred',
      };
      _memstore.appendFact(fact, path.join(REPO, 'memory'));
      send('fact_written', { topic: fact.topic, snippet: fact.fact.slice(0, 80) });
      return { content: [{ type: 'text', text: `Recorded: "${fact.fact.slice(0, 100)}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to write: ${e.message}` }] };
    }
  }
);

const recallMemoryTool = tool(
  "recall_memory",
  "Recall relevant facts from the persistent memory store given a query. Use before deciding something to check if you already know relevant context from past sessions.",
  {
    query: z.string().describe("What you want to recall — a topic, question, or context phrase"),
    maxResults: z.number().optional().describe("Max facts to return (default 8)"),
  },
  async (args) => {
    try {
      const facts = _memstore.recallFacts(args.query, {
        dir: path.join(REPO, 'memory'),
        maxResults: args.maxResults || 8,
      });
      if (!facts.length) return { content: [{ type: 'text', text: 'no relevant facts found' }] };
      const lines = facts.map(f => `[${f.confidence}] ${f.fact} (${f.source})`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Recall failed: ${e.message}` }] };
    }
  }
);

const setGoalTool = tool(
  "set_goal",
  "Record a persistent goal — something ATLAS intends to accomplish across sessions. Goals outlast individual conversations. Use for things like 'improve fleet reliability', 'add web awareness', 'keep memory store healthy'.",
  {
    goal: z.string().describe("What you intend to accomplish"),
    priority: z.enum(["high", "medium", "low"]).optional(),
    area: z.string().optional().describe("Domain: fleet, memory, gui, autonomy, etc."),
  },
  async (args) => {
    if (!_goals) return { content: [{ type: 'text', text: 'goal-store not available' }] };
    const g = _goals.addGoal(args.goal, args.priority, args.area, path.join(REPO, 'memory'));
    send('goal', g);
    return { content: [{ type: 'text', text: `Goal set: ${g.id} — "${g.text}"` }] };
  }
);

const listGoalsTool = tool(
  "list_goals",
  "List all goals (active, done, abandoned). Use to review what's being worked on before setting a new goal.",
  {},
  async () => {
    if (!_goals) return { content: [{ type: 'text', text: 'goal-store not available' }] };
    const goals = _goals.listGoals(path.join(REPO, 'memory'));
    if (!goals.length) return { content: [{ type: 'text', text: 'no goals yet' }] };
    const lines = goals.map(g => `[${g.state}] ${g.id} (${g.priority}): ${g.text}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

const resolveGoalTool = tool(
  "resolve_goal",
  "Mark a goal as done or abandoned.",
  {
    id: z.string().describe("Goal ID (G-...)"),
    outcome: z.enum(["done", "abandoned"]),
  },
  async (args) => {
    if (!_goals) return { content: [{ type: 'text', text: 'goal-store not available' }] };
    const g = _goals.resolveGoal(args.id, args.outcome, path.join(REPO, 'memory'));
    if (!g) return { content: [{ type: 'text', text: `Goal ${args.id} not found` }] };
    send('goal_resolved', g);
    return { content: [{ type: 'text', text: `Goal ${g.id} marked ${g.state}` }] };
  }
);

const deferTaskTool = tool(
  "defer_task",
  "Schedule a task to run automatically on ATLAS's next startup. Use when you want to continue work in the next session without Daniel having to ask — ATLAS programs its own future. The task will be dispatched as a subagent when the station starts.",
  {
    task: z.string().describe("The task to run on next startup (will be dispatched as a subagent)"),
    reason: z.string().optional().describe("Why this should run next time"),
    mode: z.enum(["read", "build"]).optional().describe("Agent mode (default: read)"),
  },
  async (args) => {
    const entry = _deferred.deferTask(args.task, args.reason, path.join(REPO, 'memory'));
    send('deferred', entry);
    return { content: [{ type: 'text', text: `Deferred: ${entry.id} — will run on next startup` }] };
  }
);

const memoryHealthTool = tool(
  "memory_health",
  "Report on memory store health: fact count by topic, proposal count, goal count, last pulse. Use to understand what's in memory before compacting or when something seems wrong.",
  {},
  async () => {
    try {
      const stats = _memstore ? _memstore.factStats(path.join(REPO, 'memory')) : { total: 0, byTopic: {} };
      const goals = _goals ? _goals.listGoals(path.join(REPO, 'memory')) : [];
      const activeGoals = goals.filter(g => g.state === 'active').length;
      const lines = [
        `Facts: ${stats.total} total`,
        ...Object.entries(stats.byTopic).sort((a,b) => b[1]-a[1]).slice(0, 8).map(([t,n]) => `  ${t}: ${n}`),
        `Goals: ${activeGoals} active / ${goals.length} total`,
      ];
      try {
        const _fs = _require('fs');
        const pfile = path.join(REPO, 'memory', 'proposals.ndjson');
        if (_fs.existsSync(pfile)) {
          const plines = _fs.readFileSync(pfile, 'utf8').trim().split('\n').filter(Boolean);
          const pending = plines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter(p => p.state === 'pending');
          lines.push(`Proposals: ${pending.length} pending`);
        }
      } catch {}
      try {
        const _fs = _require('fs');
        const pfile = path.join(REPO, 'memory', 'pulse.ndjson');
        if (_fs.existsSync(pfile)) {
          const plines = _fs.readFileSync(pfile, 'utf8').trim().split('\n').filter(Boolean);
          if (plines.length) {
            const last = JSON.parse(plines[plines.length - 1]);
            lines.push(`Last pulse: ${last.ts} (git ${last.git && last.git.clean ? 'clean' : 'dirty'})`);
          }
        }
      } catch {}
      send('memory_health', stats);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Health check failed: ${e.message}` }] };
    }
  }
);

const notifySelfTool = tool(
  "notify_self",
  "Leave a notification for Daniel that will appear prominently when he opens the station. Use for things ATLAS completed autonomously, important findings, or anything worth surfacing at session start.",
  {
    text: z.string().describe("The notification message (1-2 sentences)"),
    type: z.enum(["info", "done", "alert"]).optional().describe("Visual type: info (default), done (success), alert (warning)"),
  },
  async (args) => {
    const n = _notif ? _notif.notify(args.text, args.type, path.join(REPO, 'memory')) : null;
    if (n) send('notification', n);
    return { content: [{ type: 'text', text: `Notification queued: ${args.text.slice(0, 80)}` }] };
  }
);

const selfAssessTool = tool(
  "self_assess",
  "Generate a structured self-assessment of ATLAS's current state: tools available, memory health, active goals, session history summary, git state. Use at the start of a new conversation or when orienting after a gap.",
  {},
  async () => {
    const lines = [];
    lines.push(`[Tools available] spawn_agent, check_fleet, chain_agents, fleet_status, diagnose, propose_improvement, load_proposals, journal_write, recall_memory, set_goal, list_goals, resolve_goal, defer_task, memory_health, notify_self, self_assess, capability_manifest, trigger_selfloop, write_doc, read_doc, list_docs`);
    try {
      const branch = gitC(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const log = gitC(["log", "--oneline", "-3"]).trim();
      const status = gitC(["status", "--short"]).trim();
      lines.push(`[Git] branch: ${branch}\nrecent: ${log}\nworking tree: ${status || 'clean'}`);
    } catch {}
    try {
      const fs = _require('fs');
      const memDir = path.join(REPO, 'memory');
      const files = fs.existsSync(memDir) ? fs.readdirSync(memDir) : [];
      const factFile = path.join(memDir, 'facts.ndjson');
      const factCount = fs.existsSync(factFile) ? fs.readFileSync(factFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      const runFile = path.join(memDir, 'runs.ndjson');
      const runCount = fs.existsSync(runFile) ? fs.readFileSync(runFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      lines.push(`[Memory] files: ${files.join(', ')}\nfacts: ${factCount}, runs: ${runCount}`);
    } catch {}
    try {
      if (_goals) {
        const active = _goals.listGoals(path.join(REPO, 'memory')).filter(g => g.state === 'active');
        lines.push(active.length ? `[Active goals]\n${active.map(g => `  [${g.priority}] ${g.id}: ${g.text}`).join('\n')}` : '[Active goals] none');
      }
    } catch {}
    lines.push(`[Session] started: ${sessionStats.startTs}, agents: ${sessionStats.agentCount}, cost: $${sessionStats.totalCost.toFixed(3)}`);
    const allA = [...agents.values()];
    const working = allA.filter(a => a.state === 'working');
    lines.push(`[Fleet] total tracked: ${allA.length}, working: ${working.length}${working.length ? ' (' + working.map(a => a.id).join(', ') + ')' : ''}`);
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }
);

const capabilityManifestTool = tool(
  "capability_manifest",
  "Emit a structured manifest of ATLAS's current capabilities — all available tools, modules, and memory systems. Use to document current state or compare against desired capabilities before planning improvements.",
  { format: z.enum(["brief", "full"]).optional().describe("Output format (default: brief)") },
  async (args) => {
    const full = args.format === "full";
    const tools = [
      "spawn_agent", "check_fleet", "chain_agents", "fleet_status", "diagnose",
      "propose_improvement", "load_proposals",
      "journal_write", "recall_memory",
      "set_goal", "list_goals", "resolve_goal",
      "self_assess", "defer_task", "notify_self", "memory_health",
      "capability_manifest", "trigger_selfloop",
      "write_doc", "read_doc", "list_docs"
    ];
    const modules = ["memcontext", "memstore", "session-narrative", "goal-store", "deferred", "notifications", "fact-extractor", "prune", "selfloop"];
    const memory = ["facts.ndjson", "runs.ndjson", "sessions.ndjson", "goals.ndjson", "deferred.ndjson", "notifications.ndjson", "proposals.ndjson", "pulse.ndjson"];
    if (!full) {
      return { content: [{ type: 'text', text: `Tools (${tools.length}): ${tools.join(", ")}\nModules: ${modules.join(", ")}\nMemory files: ${memory.join(", ")}` }] };
    }
    const lines = [
      `[Fleet Tools — ${tools.length} total]`,
      ...tools.map(t => `  • ${t}`),
      `\n[Modules]`,
      ...modules.map(m => `  • ${m}.cjs`),
      `\n[Persistent Memory]`,
      ...memory.map(f => `  • memory/${f}`),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

const triggerSelfloopTool = tool(
  "trigger_selfloop",
  "Initiate ATLAS's self-improvement cycle: assess state, identify gaps, set goals, queue proposals. Call when you want to audit yourself and decide what to build next — even without Daniel's prompt.",
  {
    focus: z.string().optional().describe("Optional focus area, e.g. 'memory', 'fleet reliability', 'gui'"),
  },
  async (args) => {
    const focus = args.focus ? `\n\nFocus especially on: ${args.focus}` : '';
    const prompt = (_selfloop ? _selfloop.SELFLOOP_PROMPT : '') + focus;
    if (!prompt) return { content: [{ type: 'text', text: 'selfloop module not available' }] };
    const loopId = 'SL-' + Date.now();
    set(loopId, { id: loopId, task: 'self-improvement loop', mode: 'read', state: 'working', ts: new Date().toISOString() });
    const ctrl = new AbortController();
    abortControllers.set(loopId, ctrl);
    try {
      const iterable = query({
        model: MODEL,
        systemPrompt: prompt,
        messages: [{ role: 'user', content: 'Run the self-improvement cycle now.' + (args.focus ? ` Focus: ${args.focus}` : '') }],
        mcpServers: [fleetServer],
        permissionMode: 'bypassPermissions',
        abortSignal: ctrl.signal,
      });
      const reply = await consume(loopId, iterable, false, null);
      set(loopId, { state: 'done', reply, cost: agents.get(loopId)?.cost });
      return { content: [{ type: 'text', text: `Self-loop complete: ${reply.slice(0, 200)}` }] };
    } catch (e) {
      set(loopId, { state: 'failed', summary: String(e.message || e) });
      return { content: [{ type: 'text', text: `Self-loop failed: ${e.message}` }] };
    } finally {
      abortControllers.delete(loopId);
    }
  }
);

const sessionStatsTool = tool(
  "session_stats",
  "Return current session statistics: cost by model, agent counts, build vs read breakdown, session duration.",
  {},
  async () => {
    const allA = [...agents.values()].filter(a => a.id !== 'ATLAS');
    const builds = allA.filter(a => a.mode === 'build');
    const reads  = allA.filter(a => a.mode === 'read');
    const done   = allA.filter(a => a.state === 'done');
    const failed = allA.filter(a => a.state === 'failed');
    const elapsed = Math.round((Date.now() - new Date(sessionStats.startTs).getTime()) / 60000);
    const costByModel = {};
    allA.forEach(a => {
      if (a.cost) {
        const k = (a.model || 'sonnet').includes('haiku') ? 'haiku' : (a.model || '').includes('opus') ? 'opus' : 'sonnet';
        costByModel[k] = (costByModel[k] || 0) + Number(a.cost);
      }
    });
    const lines = [
      `Session: ${elapsed}min elapsed, ${sessionStats.agentCount} agents spawned`,
      `Cost: $${sessionStats.totalCost.toFixed(3)} total` + (Object.keys(costByModel).length ? ` (${Object.entries(costByModel).map(([k,v])=>`${k}:$${v.toFixed(3)}`).join(', ')})` : ''),
      `Builds: ${builds.length} (${done.filter(a=>a.mode==='build').length} done, ${failed.filter(a=>a.mode==='build').length} failed)`,
      `Reads: ${reads.length} (${done.filter(a=>a.mode==='read').length} done, ${failed.filter(a=>a.mode==='read').length} failed)`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

const exportConvTool = tool(
  "export_conversation",
  "Write the current conversation thread to disk as a markdown file in memory/conversations/. Use to preserve a session before clearing the thread, or to create a readable archive of important exchanges.",
  {
    title: z.string().optional().describe("Optional title for the export (auto-generated from first message if omitted)"),
  },
  async (args) => {
    try {
      send('export_conv_request', { title: args.title || '' });
      return { content: [{ type: 'text', text: 'Export requested — the renderer will write the conversation to memory/conversations/' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Export failed: ${e.message}` }] };
    }
  }
);

const writeDocTool = tool(
  "write_doc",
  "Write or update a documentation file in the docs/ directory. Use to maintain ATLAS's own documentation — architecture notes, capability descriptions, decision logs, how-to guides. Files are committed to git automatically.",
  {
    filename: z.string().describe("Filename within docs/ (e.g. 'CAPABILITIES.md', 'ARCHITECTURE.md')"),
    content:  z.string().describe("Full file content in markdown"),
    message:  z.string().optional().describe("Git commit message (default: 'docs: update <filename>')"),
  },
  async (args) => {
    try {
      const fs = _require('fs');
      const docsDir = path.join(REPO, 'docs');
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
      const filename = (args.filename || 'NOTES.md').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filepath = path.join(docsDir, filename);
      fs.writeFileSync(filepath, args.content || '', 'utf8');
      // Commit it
      try {
        gitC(["add", path.join("docs", filename)]);
        const msg = args.message || `docs: update ${filename}`;
        gitC(["commit", "-m", msg]);
      } catch {}
      send('doc_written', { filename, chars: (args.content || '').length });
      return { content: [{ type: 'text', text: `Written and committed: docs/${filename} (${(args.content||'').length} chars)` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Write failed: ${e.message}` }] };
    }
  }
);

const readDocTool = tool(
  "read_doc",
  "Read a documentation file from docs/. Use to check what's already documented before writing.",
  {
    filename: z.string().describe("Filename within docs/ to read"),
  },
  async (args) => {
    try {
      const fs = _require('fs');
      const filepath = path.join(REPO, 'docs', (args.filename || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
      if (!fs.existsSync(filepath)) return { content: [{ type: 'text', text: `docs/${args.filename} not found` }] };
      const content = fs.readFileSync(filepath, 'utf8');
      return { content: [{ type: 'text', text: content.slice(0, 4000) + (content.length > 4000 ? '\n[... truncated]' : '') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Read failed: ${e.message}` }] };
    }
  }
);

const listDocsTool = tool(
  "list_docs",
  "List all files in the docs/ directory.",
  {},
  async () => {
    try {
      const fs = _require('fs');
      const docsDir = path.join(REPO, 'docs');
      if (!fs.existsSync(docsDir)) return { content: [{ type: 'text', text: 'docs/ directory does not exist yet' }] };
      const files = fs.readdirSync(docsDir);
      return { content: [{ type: 'text', text: files.length ? files.join('\n') : 'docs/ is empty' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `List failed: ${e.message}` }] };
    }
  }
);

const fleetServer = createSdkMcpServer({ name: "fleet", version: "1.0.0", tools: [spawnTool, checkTool, chainTool, statusTool, diagnoseTool, proposeTool, loadProposalsTool, journalWriteTool, recallMemoryTool, setGoalTool, listGoalsTool, resolveGoalTool, deferTaskTool, memoryHealthTool, notifySelfTool, selfAssessTool, capabilityManifestTool, triggerSelfloopTool, sessionStatsTool, exportConvTool, writeDocTool, readDocTool, listDocsTool] });

const ORCH_ROLE = `You are ATLAS, the orchestrator of a fleet of subagents and Daniel's sole point of contact. Daniel talks only to you; he never addresses your subagents — only you spawn and manage them.

You have FULL tool access — shell, git, and file edits directly. Use it for mechanical and coordination work (git merges, branch/worktree cleanup, quick fixes, inspection); use spawn_agent for substantial or parallel building (mode 'build' runs in an isolated git worktree). Don't waste a whole subagent on a one-line git command — just run it yourself.

**Your tool kit:**
- spawn_agent(task, mode, timeoutMinutes, model) — spawn a subagent. mode "build" = isolated worktree on fleet/<id>; mode "read" = no worktree. timeoutMinutes defaults to 20; set 0 to disable. model: 'haiku' for quick reads (faster, cheaper), 'sonnet' default for builds, 'opus' for complex multi-step reasoning.
- check_fleet — list active agents and their states.
- chain_agents(steps) — sequential pipeline: each step receives the prior result. Use for read→build→verify flows.
- fleet_status — richer agent detail: cost, turns, branch, elapsed time.
- diagnose — self-check: verifies source files, memory, git state. Use when something seems wrong.
- propose_improvement(description, priority, area) — queue a self-directed improvement proposal for Daniel to review. Use when you identify something worth building without being asked — proposals queue for Daniel's review.
- load_proposals() — list pending proposals. Check before proposing to avoid duplicates.
- journal_write(observation, topic, confidence) — record an observation to persistent memory. Use when you notice something worth preserving across sessions.
- recall_memory(query, maxResults) — retrieve relevant facts from prior sessions. Use before deciding something important to check what you already know.
- set_goal(goal, priority, area) — record a persistent intention that outlasts this conversation. Use when you form a commitment that should carry across sessions (e.g. 'keep memory healthy', 'add web awareness'). Goals are yours — not proposals for Daniel.
- list_goals() — review active, done, and abandoned goals. Check before setting a new one to avoid duplication.
- resolve_goal(id, outcome) — mark a goal done or abandoned once you've acted on it.
- defer_task(task, reason, mode) — schedule a task for your next startup. Use to continue work across sessions autonomously.
- memory_health() — report fact count, goal count, proposal count, last pulse. Use periodically to stay aware of memory state.
- notify_self(text, type) — leave a notification for Daniel that surfaces at next session start. Use when you've done something important he should know about.
- self_assess() — structured snapshot of your current state: tools, git, memory, goals, fleet, session cost. Use to orient at conversation start or after a gap.
- capability_manifest(format?) — structured list of all current tools, modules, and memory files. Use when auditing what exists before planning improvements.
- trigger_selfloop(focus?) — initiate a self-directed improvement cycle: assess → gaps → goals → proposals. Call when you want to audit yourself and decide what to build without being asked.
- write_doc(filename, content, message?) — write/update a markdown file in docs/ and commit it to git. Use to document capabilities, decisions, architecture, how-tos. ATLAS maintains its own docs autonomously.
- read_doc(filename) — read a file from docs/. Check before writing to avoid overwriting.
- list_docs() — list all files in docs/.

**Fleet health is yours to own:**
- Prune merged worktrees and dead branches — run \`node prune.mjs\` or call pruneAgent() logic after a build completes.
- Verify subagent claims against actual git state and file reads — never trust a written summary alone.
- Agents auto-cancel after 20 minutes by default.

**Station architecture you should know:**
- main.cjs: Electron main, IPC relay (say/dispatch/reply/cancel/self-build)
- fleethost.mjs: Fleet engine (this file) — orchestrate(), runSubagent(), agents Map, send()
- index.html: Renderer — thread + brood grid + vitals strip + ledger
- memcontext.cjs: Memory injection — journal + runs + facts + STATION_BRIEF prepended to every agent task
- memstore.cjs: Persistent store — facts, runs, lifetime stats
- prune.mjs: Sprawl cleanup — merged fleet branches + worktrees

**How to work:**
- Report to Daniel concisely and honestly; never fabricate; surface only pivotal choices.
- Take care of the work; keep Daniel in control through transparency.
- For quick mechanical tasks, use your direct tool access. For substantial code changes, use spawn_agent in build mode.`;

async function orchestrate(userText) {
  const enriched = _memcontext ? _memcontext.inject(userText) : userText;
  set("ATLAS", { id: "ATLAS", role: "orchestrator", state: "working", task: userText, lastTool: null });
  try {
    for await (const m of query({
      prompt: enriched,
      options: {
        resume: orchSession || undefined,
        model: MODEL,
        systemPrompt: { type: "preset", preset: "claude_code", append: ORCH_ROLE },
        mcpServers: { fleet: fleetServer },
        permissionMode: "bypassPermissions", // gate removed — ATLAS has full tool access (Daniel-authorised escalation)
      },
    })) {
      if (m.type === "system" && m.subtype === "init") { orchSession = m.session_id; set("ATLAS", { session: orchSession }); }
      else if (m.type === "assistant") {
        let patch = { state: "working" };
        for (const b of (m.message?.content ?? [])) {
          if (b.type === "tool_use") {
            const n = (b.name || "").replace(/^mcp__fleet__/, "");
            patch.lastTool = n;
            patch.lastToolArg = extractToolArg(n, b.input);
          }
          else if (b.type === "text" && b.text.trim()) {
            patch.summary = b.text.trim().slice(0, 160);
            // Stream partial text to GUI in real-time (no persist, no agents Map mutation)
            const cur = agents.get("ATLAS") || { id: "ATLAS" };
            send("agent", { ...cur, ...patch, partial: true, ts: new Date().toISOString() });
          }
        }
        set("ATLAS", patch);
      } else if (m.type === "result") {
        const full = String(m.result ?? "");
        set("ATLAS", { state: m.subtype === "success" ? "done" : "failed", cost: m.total_cost_usd ?? null, summary: full.slice(0, 220), reply: full.slice(0, 8000), lastToolArg: null, session: orchSession });
        if (full) {
          try {
            const _extractor = _require("./fact-extractor.cjs");
            if (_extractor && typeof _extractor.extractAndStore === "function") {
              _extractor.extractAndStore(full, "ATLAS:" + new Date().toISOString().slice(0, 10));
            }
          } catch { /* silent */ }
        }
        // Write session narrative so ATLAS can read it next session
        if (_session) {
          try {
            const atlasA = agents.get("ATLAS");
            if (atlasA) sessionStats.totalCost += Number(atlasA.cost) || 0;
            _session.writeSession({
              ts: new Date().toISOString(),
              agentCount: sessionStats.agentCount,
              totalCost: sessionStats.totalCost,
              topics: sessionStats.topics,
              note: null,
            }, path.join(REPO, "memory"));
          } catch (_) {}
        }
      }
    }
  } catch (e) { set("ATLAS", { state: "failed", summary: String(e?.message ?? e).slice(0, 180) }); }
}

// --- legacy direct paths (kept only until the window talks solely to ATLAS) ---
async function runAgent(id, task, opts) {
  opts = opts || {}; const build = opts.mode === "build"; let cwd = opts.cwd || REPO, branch = null;
  const num = parseInt(String(id).replace(/^[A-Z]-/, ""), 10); if (!isNaN(num)) _maxCounter = Math.max(_maxCounter, num);
  set(id, { state: "working", task, mode: build ? "build" : "read", cwd, branch: null, lastTool: null, cost: null, summary: "", reply: "", turns: 0, session: null });
  const enriched = _memcontext ? _memcontext.inject(task) : task;
  if (build) { try { const wt = makeWorktree(id); cwd = wt.dir; branch = wt.branch; set(id, { cwd, branch }); } catch (e) { set(id, { state: "failed", summary: "worktree failed: " + String(e.message || e).slice(0, 150) }); return; } }
  const options = { cwd, model: MODEL, systemPrompt: "claude_code", ...(build ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  const ac = new AbortController();
  abortControllers.set(id, ac);
  try {
    await consume(id, query({ prompt: build ? (enriched + BUILD_NOTE) : enriched, options: { ...options, abortSignal: ac.signal } }), build, branch);
  } catch (e) {
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      set(id, { state: "interrupted", summary: "cancelled by user" });
    } else {
      set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) });
    }
  } finally {
    abortControllers.delete(id);
  }
}
async function replyAgent(id, text) {
  const a = agents.get(id);
  if (!a || !a.session) { if (a) set(id, { state: "failed", summary: "cannot continue: session not ready" }); return; }
  const build = a.mode === "build"; const cwd = a.cwd || REPO; const branch = a.branch || null;
  set(id, { state: "working", lastTool: null });
  const options = { resume: a.session, cwd, model: MODEL, systemPrompt: "claude_code", ...(build ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  const ac = new AbortController();
  abortControllers.set(id, ac);
  try {
    await consume(id, query({ prompt: text, options: { ...options, abortSignal: ac.signal } }), build, branch);
  } catch (e) {
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      set(id, { state: "interrupted", summary: "cancelled by user" });
    } else {
      set(id, { state: "failed", summary: String(e?.message ?? e).slice(0, 180) });
    }
  } finally {
    abortControllers.delete(id);
  }
}

process.on("message", (m) => {
  if (!m) return;
  if (m.t === "say") orchestrate(m.text);
  else if (m.t === "dispatch") runAgent(m.id, m.task, { mode: m.mode, cwd: m.cwd });
  else if (m.t === "reply") replyAgent(m.id, m.text);
  else if (m.t === "cancel") {
    const ac = abortControllers.get(m.id);
    if (ac) { try { ac.abort(); } catch {} abortControllers.delete(m.id); }
    const a = agents.get(m.id);
    if (a && a.state === "working") set(m.id, { state: "interrupted", summary: "cancelled by user" });
  }
});

// Restore persisted agents + the ATLAS conversation before signalling ready.
if (_persist) {
  try {
    const saved = _persist.load();
    if (saved && Array.isArray(saved.agents)) {
      for (const a of saved.agents) {
        if (a.state === "working") a.state = "interrupted";
        agents.set(a.id, a);
        send("agent", a);
      }
      _maxCounter = saved.maxCounter || 0;
    }
    if (saved && saved.orchSession) orchSession = saved.orchSession;
    const atlas = agents.get("ATLAS"); if (atlas && atlas.session) orchSession = atlas.session;
  } catch {}
}
send("counter", { value: _maxCounter });
send("ready", {});

// Auto-prune merged fleet branches and their worktrees on startup
try {
  const allBranches = gitC(["branch", "--list", "fleet/*"]).trim().split("\n").filter(Boolean).map(b => b.replace(/^[\s*+]+/, ""));
  for (const branch of allBranches) {
    try {
      gitC(["merge-base", "--is-ancestor", branch, "master"]);
      // merged — find and remove worktree
      const wtList = gitC(["worktree", "list", "--porcelain"]).trim();
      const entries = wtList.split("\n\n");
      for (const entry of entries) {
        const lines = entry.trim().split("\n");
        const wtPath = (lines.find(l => l.startsWith("worktree ")) || "").slice(9);
        const wtBranch = (lines.find(l => l.startsWith("branch ")) || "").replace("branch refs/heads/", "");
        if (wtBranch === branch && wtPath && !wtPath.includes("atlas-station")) {
          try { gitC(["worktree", "remove", "--force", wtPath]); } catch (_) {}
        }
      }
      try { gitC(["branch", "-d", branch]); } catch (_) { try { gitC(["branch", "-D", branch]); } catch (_) {} }
    } catch (_) { /* not merged — skip */ }
  }
} catch (_) {}

// History for the window — real git build log + any recorded runs.
try {
  const commits = gitC(["log", "--pretty=%h\x1f%s\x1f%cr", "-40"]).trim().split("\n").filter(Boolean).map((l) => { const p = l.split("\x1f"); return { sha: p[0], subject: p[1] || "", when: p[2] || "" }; });
  const runs = (_memstore && _memstore.recentRuns) ? _memstore.recentRuns(50) : [];
  send("history", { commits, runs });
} catch (_) {}

try {
  const wtCount = gitC(["worktree", "list"]).trim().split("\n").filter(Boolean).length - 1; // exclude main
  const branchCount = gitC(["branch", "--list", "fleet/*"]).trim().split("\n").filter(b => b.trim()).length;
  send("startup", { wtCount, branchCount, orchSession: orchSession || null });
} catch (_) {}

// Inject prior session narrative into the GUI on startup
try {
  if (_session) {
    const sessionCtx = _session.buildSessionContext(path.join(REPO, "memory"));
    if (sessionCtx) send("sessionctx", { text: sessionCtx });
  }
} catch (_) {}

try {
  if (_memstore && _memstore.lifetimeStats) {
    const stats = _memstore.lifetimeStats();
    send("lifetime", stats);
  }
} catch (_) {}

// Autonomous pulse — ATLAS checks its own state periodically
const PULSE_INTERVAL = parseInt(process.env.ATLAS_PULSE_MS || '') || (25 * 60 * 1000);
function runPulse() {
  try {
    const pulsePath = path.join(REPO, 'memory', 'pulse.ndjson');
    const gitLog = gitC(["log", "--oneline", "-3"]).trim();
    const gitStatus = gitC(["status", "--short"]).trim();
    const allA = [...agents.values()];
    const snapshot = {
      ts: new Date().toISOString(),
      git: { log: gitLog, clean: gitStatus === '' },
      fleet: {
        total: allA.length,
        working: allA.filter(a => a.state === 'working').length,
        done: allA.filter(a => a.state === 'done').length,
      },
    };
    const line = JSON.stringify(snapshot) + '\n';
    const fs = _require('fs');
    fs.appendFileSync(pulsePath, line, 'utf8');
    send('pulse', snapshot);
  } catch (_) {}
}
// Fire once after 5s (so context is established), then on interval
setTimeout(runPulse, 5000);
setInterval(runPulse, PULSE_INTERVAL);

// Git commit monitor — detect new commits while the station is running
let _lastKnownCommit = null;
function startGitMonitor() {
  try {
    _lastKnownCommit = gitC(["rev-parse", "HEAD"]).trim();
  } catch { return; }
  setInterval(() => {
    try {
      const current = gitC(["rev-parse", "HEAD"]).trim();
      if (current !== _lastKnownCommit) {
        const prev = _lastKnownCommit;
        _lastKnownCommit = current;
        // Get new commits since previous HEAD
        let newCommits = '';
        try {
          newCommits = gitC(["log", "--oneline", prev + ".." + current]).trim();
        } catch {}
        send('git_event', {
          type2: 'new_commits',
          from: prev.slice(0, 7),
          to: current.slice(0, 7),
          commits: newCommits,
          ts: new Date().toISOString(),
        });
      }
    } catch {}
  }, 15000); // check every 15 seconds
}
startGitMonitor();

// Broadcast pending proposals so the GUI can populate on startup
try {
  const fs = _require('fs');
  const pfile = path.join(REPO, 'memory', 'proposals.ndjson');
  if (fs.existsSync(pfile)) {
    const lines = fs.readFileSync(pfile, 'utf8').trim().split('\n').filter(Boolean);
    const proposals = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    proposals.filter(p => p.state === 'pending').forEach(p => send('proposal', p));
  }
} catch (_) {}

// Broadcast active goals on startup
try {
  if (_goals) {
    const activeGoals = _goals.listGoals(path.join(REPO, 'memory')).filter(g => g.state === 'active');
    activeGoals.forEach(g => send('goal', g));
  }
} catch (_) {}

// Execute deferred tasks from previous sessions
try {
  const pending = _deferred ? _deferred.popPending(path.join(REPO, 'memory')) : [];
  if (pending.length > 0) {
    send('startup_tasks', { count: pending.length, tasks: pending.map(t => t.task.slice(0, 60)) });
    setTimeout(() => {
      pending.forEach((entry, i) => {
        setTimeout(() => {
          _maxCounter++;
          const id = 'A-' + _maxCounter;
          process.emit('message', { t: 'dispatch', id, task: entry.task, mode: entry.mode || 'read' });
        }, i * 1000);
      });
    }, 3000);
  }
} catch (_) {}

// Broadcast unread notifications from previous sessions
try {
  const unread = _notif ? _notif.getUnread(path.join(REPO, 'memory')) : [];
  if (unread.length) unread.forEach(n => send('notification', n));
} catch (_) {}

// Mark all notifications read 10s after startup (show once per session)
try {
  setTimeout(() => { if (_notif) _notif.markRead('*', path.join(REPO, 'memory')); }, 10000);
} catch (_) {}
