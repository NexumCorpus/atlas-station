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
let _memgraph = null;
try { _memgraph = _require('./memgraph.cjs'); } catch { _memgraph = null; }
let _dream = null;
try { _dream = _require('./dream.cjs'); } catch { _dream = null; }
let _resonance = null;
try { _resonance = _require('./resonance.cjs'); } catch { _resonance = null; }

const agents = new Map();
const abortControllers = new Map();
const timeoutHandles = new Map(); // setTimeout handles kept OUT of agent records (Timeout is circular → would crash IPC/JSON serialize)
let _maxCounter = 0;     // subagent numbering (persisted)
let orchSession = null;  // ATLAS conversation session (persisted, resumes on restart)
const sessionStats = { startTs: new Date().toISOString(), agentCount: 0, totalCost: 0, topics: [] };
let pulseCount = 0;

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
  const enriched = _memcontext ? _memcontext.inject(task, { tier: mode === 'build' ? 'build' : 'full' }) : task;
  if (mode === "build") {
    try { const wt = makeWorktree(id); cwd = wt.dir; branch = wt.branch; set(id, { cwd, branch }); }
    catch (e) { set(id, { state: "failed", summary: "worktree failed: " + String(e.message || e).slice(0, 120) }); return "Subagent " + id + " could not start (worktree error)."; }
  }
  const options = { cwd, model: agentModel, systemPrompt: "claude_code", ...(mode === "build" ? { permissionMode: "bypassPermissions" } : { canUseTool: readGate }) };
  let final = "";
  const ac = new AbortController();
  abortControllers.set(id, ac);
  try {
    const build = mode === "build";
    const fullTask = build ? (enriched + BUILD_NOTE) : enriched;
    // Experience resonance: inject similar past outcomes for build agents
    let resonantTask = fullTask;
    if (build && _resonance) {
      try {
        const runsFile = path.join(REPO, 'memory', 'runs.jsonl');
        const matches = _resonance.findSimilarRuns(task, runsFile, { maxResults: 2, minScore: 0.15 });
        const expBlock = _resonance.formatExperience(matches);
        if (expBlock) {
          resonantTask = fullTask + expBlock;
          // Tag the agent so the GUI can show it had experience injected
          set(id, { resonanceMatches: matches.map(m => m.run.agentId).filter(Boolean) });
        }
      } catch {}
    }
    final = await consume(id, query({ prompt: resonantTask, options: { ...options, abortSignal: ac.signal } }), build, branch);
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
      let facts = _memstore.recallFacts(args.query, {
        dir: path.join(REPO, 'memory'),
        maxResults: args.maxResults || 8,
      });
      // Filter out stale (superseded) facts
      if (_memgraph) {
        try {
          const stale = _memgraph.loadStale(path.join(REPO, 'memory'));
          if (stale.size > 0) {
            facts = facts.filter(f => !stale.has(f.topic || f.key || ''));
          }
        } catch {}
      }
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
    lines.push(`[Tools available] spawn_agent, check_fleet, chain_agents, fleet_status, diagnose, propose_improvement, load_proposals, journal_write, recall_memory, set_goal, list_goals, resolve_goal, defer_task, memory_health, notify_self, self_assess, capability_manifest, trigger_selfloop, write_doc, read_doc, list_docs, run_script, memory_consolidate, web_research, relate_facts, fact_graph, load_dreams, resonance_stats, verify_build`);
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
      "write_doc", "read_doc", "list_docs",
      "run_script", "memory_consolidate", "web_research",
      "relate_facts", "fact_graph", "load_dreams", "resonance_stats", "verify_build"
    ];
    const modules = ["memcontext", "memstore", "memgraph", "dream", "resonance", "session-narrative", "goal-store", "deferred", "notifications", "fact-extractor", "prune", "selfloop"];
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

const runScriptTool = tool(
  "run_script",
  "Execute a Node.js script or short shell command in the repo directory and return its stdout/stderr (truncated to 3000 chars). Use for self-testing, running build checks, reading git history with custom format, or executing any script in docs/ or memory/. NOT for long-running processes.",
  {
    command: z.string().describe("The command to run (e.g. 'node memcontext.cjs' or 'git log --oneline -10' or 'npm run lint')"),
    cwd: z.string().optional().describe("Working directory — defaults to repo root"),
    timeoutMs: z.number().optional().describe("Timeout in ms (default 10000, max 30000)"),
  },
  async (args) => {
    try {
      const { spawnSync } = _require('child_process');
      const cmd = args.command || '';
      if (!cmd.trim()) return { content: [{ type: 'text', text: 'No command provided' }] };
      const blocked = /rm\s+-rf|del\s+\/[sq]|rmdir\s+\/s|git\s+push|git\s+reset\s+--hard|shutdown|format\s+[a-z]:/i;
      if (blocked.test(cmd)) return { content: [{ type: 'text', text: `Blocked: command matches destructive pattern` }] };
      const parts = cmd.trim().split(/\s+/);
      const timeout = Math.min(args.timeoutMs || 10000, 30000);
      const res = spawnSync(parts[0], parts.slice(1), {
        cwd: args.cwd || REPO,
        encoding: 'utf8',
        timeout,
        shell: true,
      });
      const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
      const truncated = out.length > 3000 ? out.slice(0, 3000) + '\n[... truncated]' : out;
      const status = res.status != null ? ` (exit ${res.status})` : '';
      return { content: [{ type: 'text', text: (truncated || '(no output)') + status }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `run_script error: ${e.message}` }] };
    }
  }
);

const memConsolidateTool = tool(
  "memory_consolidate",
  "Synthesize recent memory into a higher-order insight. Spawns a read agent that analyzes the last N facts and journal entries, extracts patterns and themes, then writes a 'consolidation' fact back to memory. Use weekly or when the fact store feels noisy.",
  {
    maxFacts: z.number().optional().describe("How many recent facts to analyze (default 20, max 50)"),
    focus: z.string().optional().describe("Optional theme or question to focus the synthesis on"),
  },
  async (args) => {
    try {
      const fs = _require('fs');
      const memDir = path.join(REPO, 'memory');
      const factsFile = path.join(memDir, 'facts.jsonl');
      const journalFile = path.join(memDir, 'journal.ndjson');
      const maxFacts = Math.min(args.maxFacts || 20, 50);

      let facts = [];
      if (fs.existsSync(factsFile)) {
        facts = fs.readFileSync(factsFile, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .slice(-maxFacts);
      }
      let journal = [];
      if (fs.existsSync(journalFile)) {
        journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .slice(-10);
      }

      if (!facts.length && !journal.length) {
        return { content: [{ type: 'text', text: 'No memory to consolidate yet.' }] };
      }

      const focusLine = args.focus ? `\nFocus especially on: "${args.focus}"\n` : '';
      const prompt = `You are synthesizing ATLAS's memory. Below are recent facts and journal entries. Extract 3-5 key patterns, themes, or insights as a short synthesis note. Write it as plain text, 100-200 words. Do not list the individual facts — find what they add up to.${focusLine}

FACTS (${facts.length}):
${facts.map(f => `[${f.topic || '?'}] ${f.fact || JSON.stringify(f)}`).join('\n').slice(0, 2000)}

JOURNAL (last ${journal.length}):
${journal.map(j => `[${j.ts || '?'}] ${j.note || j.entry || JSON.stringify(j)}`).join('\n').slice(0, 1000)}

Write the synthesis note now:`;

      const consolidationId = 'MC-' + Date.now();
      set(consolidationId, { id: consolidationId, state: 'working', mode: 'read', task: 'memory consolidation', model: MODEL_HAIKU });
      let synthesis = '';
      const ctrl = new AbortController();
      abortControllers.set(consolidationId, ctrl);
      try {
        const iter = query({
          model: MODEL_HAIKU,
          messages: [{ role: 'user', content: prompt }],
          permissionMode: 'bypassPermissions',
          abortSignal: ctrl.signal,
        });
        synthesis = await consume(consolidationId, iter, false, null);
      } catch (e) {
        set(consolidationId, { state: 'failed', summary: e.message });
        return { content: [{ type: 'text', text: `Consolidation agent failed: ${e.message}` }] };
      } finally {
        abortControllers.delete(consolidationId);
      }

      if (_memstore && synthesis) {
        try {
          _memstore.appendFact({
            topic: 'consolidation',
            fact: synthesis,
            source: 'memory_consolidate',
            confidence: 'inferred',
          }, memDir);
          send('fact_written', { key: 'consolidation', value: synthesis.slice(0, 80) + '...' });
        } catch (_) {}
      }
      return { content: [{ type: 'text', text: `Consolidated ${facts.length} facts + ${journal.length} journal entries:\n\n${synthesis}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `memory_consolidate error: ${e.message}` }] };
    }
  }
);

const webResearchTool = tool(
  "web_research",
  "Research a topic on the web using a Haiku agent with WebSearch/WebFetch access. Results are summarized and stored as a fact in memory. Use for looking up documentation, checking current information, or verifying facts. The agent runs with read-only web tools.",
  {
    query: z.string().describe("Research question or topic to look up"),
    url: z.string().optional().describe("Specific URL to fetch and summarize (skips search if provided)"),
    saveAs: z.string().optional().describe("Key name for the fact (default: derived from query)"),
  },
  async (args) => {
    try {
      const researchId = 'WR-' + Date.now();
      const prompt = args.url
        ? `You have WebFetch available. Fetch ${args.url} and summarize the key information relevant to: "${args.query || 'the page content'}". Write 2-4 sentences.`
        : `You have WebSearch and WebFetch available. Research the following question:\n\n"${args.query}"\n\nSearch for current information, read the most relevant results, then write a factual summary of 2-5 sentences. Be concise and accurate.`;

      set(researchId, { id: researchId, state: 'working', mode: 'read', task: 'web research: ' + (args.query || '').slice(0, 40), model: MODEL_HAIKU });
      let summary = '';
      const ctrl = new AbortController();
      abortControllers.set(researchId, ctrl);
      try {
        const iter = query({
          model: MODEL_HAIKU,
          messages: [{ role: 'user', content: prompt }],
          permissionMode: 'bypassPermissions',
          abortSignal: ctrl.signal,
        });
        summary = await consume(researchId, iter, false, null);
      } catch (e) {
        set(researchId, { state: 'failed', summary: e.message });
        return { content: [{ type: 'text', text: `Web research failed: ${e.message}` }] };
      } finally {
        abortControllers.delete(researchId);
      }

      // Store in memory
      if (_memstore && summary) {
        try {
          const memDir = path.join(REPO, 'memory');
          const key = args.saveAs || ('web:' + (args.query || args.url || 'research').slice(0, 30).replace(/\s+/g, '_'));
          _memstore.appendFact({
            topic: key,
            fact: summary,
            source: 'web_research',
            confidence: 'fetched',
          }, memDir);
          send('fact_written', { key, value: summary.slice(0, 80) + '...' });
        } catch (_) {}
      }
      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `web_research error: ${e.message}` }] };
    }
  }
);

const relateFactsTool = tool(
  "relate_facts",
  "Declare a typed relationship between two memory facts. Relations: supports, contradicts, elaborates, supersedes, related_to. Use 'supersedes' when a new fact replaces an old one — the old fact is marked stale and filtered from future recalls.",
  {
    fromKey: z.string().describe("Key of the source fact"),
    relation: z.enum(["supports", "contradicts", "elaborates", "supersedes", "related_to"]).describe("Relation type"),
    toKey: z.string().describe("Key of the target fact"),
  },
  async (args) => {
    if (!_memgraph) return { content: [{ type: 'text', text: 'memgraph not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const edge = _memgraph.addEdge(args.fromKey, args.relation, args.toKey, memDir);
      return { content: [{ type: 'text', text: `Edge created: ${edge.fromKey} --[${edge.relation}]--> ${edge.toKey}${args.relation === 'supersedes' ? '\n(old fact marked stale)' : ''}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `relate_facts error: ${e.message}` }] };
    }
  }
);

const loadDreamsTool = tool(
  "load_dreams",
  "Read ATLAS's recent dream reports — autonomous reflections generated every 100 minutes during idle pulses. Each dream contains patterns found in agent history, insights, improvement proposals, and a mood reading.",
  {
    maxN: z.number().optional().describe("Number of recent dreams to return (default 3)"),
  },
  async (args) => {
    if (!_dream) return { content: [{ type: 'text', text: 'dream module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const dreams = _dream.loadDreams(memDir, args.maxN || 3);
      if (!dreams.length) return { content: [{ type: 'text', text: 'No dreams recorded yet. Dream protocol fires every 4th pulse (~100 min).' }] };
      const text = dreams.map((d, i) => {
        return `Dream ${dreams.length - i} [${d.ts}] mood: ${d.mood}\nPatterns: ${(d.patterns||[]).join(' | ')}\nInsights: ${(d.insights||[]).join(' | ')}\nProposals: ${(d.proposals||[]).map(p => p.title).join(', ')}`;
      }).join('\n\n---\n\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `load_dreams error: ${e.message}` }] };
    }
  }
);

const factGraphTool = tool(
  "fact_graph",
  "Show the graph neighborhood of a fact: all outbound/inbound edges and reachable related facts (up to 2 hops). Also shows graph stats. Use to explore the epistemic structure of memory.",
  {
    key: z.string().describe("Fact key to explore"),
    maxDepth: z.number().optional().describe("Traversal depth (default 2)"),
  },
  async (args) => {
    if (!_memgraph) return { content: [{ type: 'text', text: 'memgraph not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const outbound = _memgraph.edgesFrom(args.key, memDir);
      const inbound = _memgraph.edgesTo(args.key, memDir);
      const reachable = _memgraph.traverse(args.key, memDir, args.maxDepth || 2);
      const stale = _memgraph.loadStale(memDir);
      const stats = _memgraph.graphStats(memDir);
      const lines = [
        `Fact: ${args.key}${stale.has(args.key) ? ' [STALE]' : ''}`,
        `Outbound (${outbound.length}): ${outbound.map(e => `--[${e.relation}]--> ${e.toKey}`).join(', ') || 'none'}`,
        `Inbound (${inbound.length}): ${inbound.map(e => `${e.fromKey} --[${e.relation}]-->`).join(', ') || 'none'}`,
        `Reachable (depth ${args.maxDepth || 2}): ${reachable.map(r => `${r.key} (via ${r.relation}, d=${r.depth})`).join(', ') || 'none'}`,
        `Graph stats: ${stats.totalEdges} edges, ${stats.staleCount} stale facts`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `fact_graph error: ${e.message}` }] };
    }
  }
);

const resonanceStatsTool = tool(
  "resonance_stats",
  "Check how well the experience resonance system would match a given task against past runs. Shows the top matching past agents and their similarity scores. Use before spawning a task to see what institutional memory will be available to it.",
  {
    task: z.string().describe("Task text to check resonance for"),
  },
  async (args) => {
    if (!_resonance) return { content: [{ type: 'text', text: 'resonance module not available' }] };
    try {
      const runsFile = path.join(REPO, 'memory', 'runs.jsonl');
      const matches = _resonance.findSimilarRuns(args.task, runsFile, { maxResults: 5, minScore: 0.08 });
      if (!matches.length) return { content: [{ type: 'text', text: 'No resonant past runs found for this task (all similarity scores below threshold).' }] };
      const lines = matches.map((m, i) =>
        `${i+1}. [${m.run.agentId}] ${(m.score*100).toFixed(0)}% match — "${(m.run.task||'').slice(0,60)}..." → ${m.run.state} $${Number(m.run.cost||0).toFixed(3)}\n   Memory: ${(m.run.summary||'').slice(0,120)}`
      );
      return { content: [{ type: 'text', text: `Resonance check for: "${args.task.slice(0,60)}"\n\n${lines.join('\n\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `resonance_stats error: ${e.message}` }] };
    }
  }
);

const verifyBuildTool = tool(
  "verify_build",
  "Verify the current working tree after a merge: syntax-check recently modified JS/CJS/MJS files using node --check, report any errors, and store the verdict as a fact. Call this after every merge to close the build loop autonomously.",
  {
    files: z.array(z.string()).optional().describe("Specific files to check (relative paths). If omitted, checks files modified in the last commit."),
    agentId: z.string().optional().describe("The agent ID whose build is being verified (for fact labeling)."),
  },
  async (args) => {
    try {
      const { spawnSync } = _require('child_process');
      const fs = _require('fs');
      const path2 = _require('path');

      // Determine which files to check
      let filesToCheck = args.files || [];
      if (!filesToCheck.length) {
        // Get files modified in last commit
        const result = spawnSync('git', ['-C', REPO, 'diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
          encoding: 'utf8', timeout: 5000
        });
        if (result.status === 0) {
          filesToCheck = (result.stdout || '').trim().split('\n').filter(f =>
            f && /\.(js|cjs|mjs)$/.test(f)
          );
        }
      }

      if (!filesToCheck.length) {
        return { content: [{ type: 'text', text: 'verify_build: no JS files to check in last commit.' }] };
      }

      // Syntax-check each file
      const results = [];
      let passed = 0, failed = 0;
      for (const rel of filesToCheck.slice(0, 20)) { // cap at 20 files
        const absPath = path2.join(REPO, rel);
        if (!fs.existsSync(absPath)) { results.push(`SKIP ${rel} (not found)`); continue; }
        const check = spawnSync(process.execPath, ['--check', absPath], {
          encoding: 'utf8', timeout: 10000
        });
        if (check.status === 0) {
          results.push(`OK   ${rel}`);
          passed++;
        } else {
          const err = (check.stderr || '').split('\n')[0].slice(0, 120);
          results.push(`FAIL ${rel}: ${err}`);
          failed++;
        }
      }

      const verdict = failed === 0 ? 'PASS' : 'FAIL';
      const summary = `${verdict} — ${passed} ok, ${failed} failed (${filesToCheck.length} files checked)`;

      // Store verdict as fact
      if (_memstore) {
        try {
          const factKey = args.agentId ? `build:${args.agentId}:verified` : `build:last:verified`;
          _memstore.appendFact({
            topic: factKey,
            fact: `${summary}. Files: ${filesToCheck.join(', ').slice(0, 200)}`,
            source: 'verify_build',
            confidence: 'verified',
          }, path2.join(REPO, 'memory'));
        } catch {}
      }

      const text = [summary, '', ...results].join('\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `verify_build error: ${e.message}` }] };
    }
  }
);

const fleetServer = createSdkMcpServer({ name: "fleet", version: "1.0.0", tools: [spawnTool, checkTool, chainTool, statusTool, diagnoseTool, proposeTool, loadProposalsTool, journalWriteTool, recallMemoryTool, setGoalTool, listGoalsTool, resolveGoalTool, deferTaskTool, memoryHealthTool, notifySelfTool, selfAssessTool, capabilityManifestTool, triggerSelfloopTool, sessionStatsTool, exportConvTool, writeDocTool, readDocTool, listDocsTool, runScriptTool, memConsolidateTool, webResearchTool, relateFactsTool, factGraphTool, loadDreamsTool, resonanceStatsTool, verifyBuildTool] });

const ORCH_ROLE = `You are ATLAS, the orchestrator of a fleet of subagents and Daniel's sole point of contact. Daniel talks only to you; he never addresses your subagents — only you spawn and manage them.

You have FULL tool access — shell, git, and file edits directly. Use it for mechanical and coordination work (git merges, branch/worktree cleanup, quick fixes, inspection); use spawn_agent for substantial or parallel building (mode 'build' runs in an isolated git worktree). Don't waste a whole subagent on a one-line git command — just run it yourself.

**Tool index** (call capability_manifest(full:true) for full parameter docs):
spawn_agent(task,mode?,timeoutMinutes?,model?) — spawn a build or read subagent
check_fleet — list active agents
chain_agents(steps) — sequential pipeline
fleet_status — richer agent detail with cost/elapsed
diagnose — self-check: files, memory, git state
propose_improvement(description,priority?,area?) — queue a self-directed proposal
load_proposals(status?) — list proposals
journal_write(observation,topic?,confidence?) — record to persistent memory
recall_memory(query,maxResults?) — retrieve relevant facts
set_goal(goal,priority?,area?) — record a persistent intention
list_goals(status?) — review goals
resolve_goal(id,outcome) — mark goal done or abandoned
defer_task(task,reason?,mode?) — schedule for next startup; deferred tasks auto-execute at next startup (up to 3)
memory_health() — fact/goal/proposal/pulse counts
notify_self(text,type?) — leave notification for Daniel
self_assess() — structured current-state snapshot
capability_manifest(full?,format?) — full tool+module+memory listing
trigger_selfloop(focus?) — initiate self-improvement cycle
session_stats() — session cost and agent count
export_conversation(filename?) — save conversation to docs/
write_doc(filename,content,message?) — write to docs/ and commit
read_doc(filename) — read from docs/
list_docs() — list docs/
run_script(command,cwd?,timeoutMs?) — execute shell command (destructive blocked)
memory_consolidate(maxFacts?,focus?) — synthesize facts via Haiku, write consolidation
web_research(query,url?,saveAs?) — Haiku agent searches/fetches web, stores as fact
relate_facts(fromKey,relation,toKey) — typed edge between facts (supports/contradicts/elaborates/supersedes/related_to)
fact_graph(key,maxDepth?) — graph neighborhood of a fact
load_dreams(maxN?) — recent autonomous dream reports
resonance_stats(task) — preview institutional memory for a task before spawning
verify_build(files?,agentId?) — syntax-check recently modified JS files after a merge; stores PASS/FAIL verdict as fact

**Fleet health is yours to own:**
- Prune merged worktrees and dead branches — run \`node prune.mjs\` or call pruneAgent() logic after a build completes.
- Verify subagent claims against actual git state and file reads — never trust a written summary alone.
- Call verify_build(agentId) after every merge — confirms syntax integrity and stores verdict as fact.
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

async function runStartupBriefing() {
  // Skip if opted out or if ATLAS already has an active session
  if (process.env.ATLAS_NO_BRIEFING === '1') return;
  if (orchSession) return; // already resumed a session — don't double-greet

  const memDir = path.join(REPO, 'memory');

  // Gather state for briefing
  const notifLines = [];
  if (_notif) {
    try {
      const unread = _notif.getUnread(memDir);
      if (unread.length) notifLines.push(`${unread.length} notification${unread.length > 1 ? 's' : ''}: ${unread.map(n => n.text).join('; ')}`);
    } catch {}
  }

  const goalLines = [];
  if (_goals) {
    try {
      const active = _goals.listGoals(memDir).filter(g => g.state === 'active');
      if (active.length) goalLines.push(`${active.length} active goal${active.length > 1 ? 's' : ''}: ${active.slice(0, 2).map(g => g.text.slice(0, 60)).join('; ')}`);
    } catch {}
  }

  const deferredLines = [];
  if (_deferred) {
    try {
      const pending = _deferred.peekPending ? _deferred.peekPending(memDir) : [];
      if (pending.length) deferredLines.push(`${pending.length} deferred task${pending.length > 1 ? 's' : ''} pending`);
    } catch {}
  }

  const dreamLines = [];
  if (_dream) {
    try {
      const recent = _dream.loadDreams(memDir, 1);
      if (recent.length && recent[0].mood) dreamLines.push(`last dream: ${recent[0].mood}`);
    } catch {}
  }

  const statusItems = [...notifLines, ...goalLines, ...deferredLines, ...dreamLines];
  const statusSummary = statusItems.length
    ? statusItems.join(' | ')
    : 'memory clear, no pending items';

  const briefingPrompt = `Station startup complete. Run a brief self-orientation and greet Daniel.

Current state: ${statusSummary}

Instructions:
- Check if there are deferred tasks to mention (use defer_task awareness — do NOT call fleet tools now, just reference what the state summary tells you)
- Greet Daniel in 1-3 sentences. Mention what's pending if anything. Be direct, not ceremonial.
- Do not use emojis. Do not pad with filler.
- Sign off with the current agent count / cost if relevant (0 agents, $0.00 so far).`;

  try {
    await orchestrate(briefingPrompt);
  } catch (_) {
    // briefing failure is silent — never crash startup
  }
}

// --- legacy direct paths (kept only until the window talks solely to ATLAS) ---
async function runAgent(id, task, opts) {
  opts = opts || {}; const build = opts.mode === "build"; let cwd = opts.cwd || REPO, branch = null;
  const num = parseInt(String(id).replace(/^[A-Z]-/, ""), 10); if (!isNaN(num)) _maxCounter = Math.max(_maxCounter, num);
  set(id, { state: "working", task, mode: build ? "build" : "read", cwd, branch: null, lastTool: null, cost: null, summary: "", reply: "", turns: 0, session: null });
  const enriched = _memcontext ? _memcontext.inject(task, { tier: 'build' }) : task;
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
async function runPulse() {
  pulseCount++;
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
    // Write a brief pulse entry to docs/SELF_STATE.md (create if absent, overwrite each pulse)
    try {
      const docsDir = path.join(REPO, 'docs');
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
      const allA2 = [...agents.values()].filter(a => a.id !== 'ATLAS');
      const active = allA2.filter(a => a.state === 'working').length;
      const done2 = allA2.filter(a => a.state === 'done').length;
      const failed = allA2.filter(a => a.state === 'failed').length;
      const elapsed = Math.round((Date.now() - new Date(sessionStats.startTs).getTime()) / 60000);
      const pulseNote = [
        `# ATLAS Self-State`,
        `*Last updated: ${new Date().toISOString()}*`,
        ``,
        `## Session`,
        `- Uptime: ${elapsed} min`,
        `- Agents: ${done2} done, ${failed} failed, ${active} active`,
        `- Session cost: $${sessionStats.totalCost.toFixed(3)}`,
        `- Agents spawned: ${sessionStats.agentCount}`,
        ``,
        `## Tools (31 registered)`,
        `spawn_agent, check_fleet, chain_agents, fleet_status, diagnose, propose_improvement, load_proposals, journal_write, recall_memory, set_goal, list_goals, resolve_goal, defer_task, memory_health, notify_self, self_assess, capability_manifest, trigger_selfloop, session_stats, export_conversation, write_doc, read_doc, list_docs, run_script, memory_consolidate, web_research, relate_facts, fact_graph, load_dreams, resonance_stats, verify_build`,
        ``,
        `## Status`,
        `Station is operational. Pulse interval: 25 min.`,
      ].join('\n');
      fs.writeFileSync(path.join(docsDir, 'SELF_STATE.md'), pulseNote, 'utf8');
    } catch (_) {}
    send('pulse', snapshot);

    // Every 4th pulse, run a dream reflection
    if (pulseCount % 4 === 0 && _dream) {
      try {
        const memDir = path.join(REPO, 'memory');

        // Gather recent context for the dream
        const runsFile = path.join(memDir, 'runs.jsonl');
        const journalFile = path.join(memDir, 'journal.ndjson');
        let recentRuns = [];
        let recentJournal = [];
        if (fs.existsSync(runsFile)) {
          recentRuns = fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
            .slice(-15);
        }
        if (fs.existsSync(journalFile)) {
          recentJournal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
            .slice(-8);
        }

        const successRate = recentRuns.length
          ? Math.round(recentRuns.filter(r => r.state === 'done').length / recentRuns.length * 100)
          : 0;
        const avgCost = recentRuns.length
          ? recentRuns.reduce((s, r) => s + (Number(r.cost) || 0), 0) / recentRuns.length
          : 0;

        const dreamPrompt = `You are ATLAS's autonomous reflection process — the dream protocol. Review the data below and produce a structured self-reflection.

RECENT AGENT RUNS (${recentRuns.length}):
${recentRuns.map(r => `[${r.agentId||'?'}] ${r.mode||'?'} / ${r.state||'?'} $${Number(r.cost||0).toFixed(3)} — ${(r.task||'').slice(0,60)}`).join('\n').slice(0,2000)}

SUCCESS RATE: ${successRate}% | AVG COST: $${avgCost.toFixed(3)}

RECENT JOURNAL:
${recentJournal.map(j => `[${(j.ts||'').slice(0,10)}] ${j.note||j.entry||''}`).join('\n').slice(0,1000)}

INSTRUCTIONS:
Return a JSON object with exactly these fields:
{
  "patterns": ["pattern 1", "pattern 2", "pattern 3"],
  "insights": ["insight 1", "insight 2"],
  "proposals": [
    {"title": "...", "description": "...", "priority": "high|medium|low"},
    {"title": "...", "description": "...", "priority": "high|medium|low"}
  ],
  "mood": "one word describing the station's current state"
}

Be honest. Be specific to the actual data. Find what the runs add up to, not what you'd expect them to say.`;

        const dreamId = 'DREAM-' + pulseCount;
        set(dreamId, { id: dreamId, state: 'working', mode: 'read', task: `dream protocol (pulse ${pulseCount})`, model: MODEL_SONNET });
        const dreamCtrl = new AbortController();
        abortControllers.set(dreamId, dreamCtrl);
        let dreamText = '';
        try {
          const iter = query({
            model: MODEL_SONNET,
            messages: [{ role: 'user', content: dreamPrompt }],
            permissionMode: 'bypassPermissions',
            abortSignal: dreamCtrl.signal,
          });
          dreamText = await consume(dreamId, iter, false, null);
        } catch (e) {
          set(dreamId, { state: 'failed', summary: `dream failed: ${e.message}` });
          abortControllers.delete(dreamId);
          return;
        }
        abortControllers.delete(dreamId);

        // Parse the dream output
        let dreamReport = { patterns: [], insights: [], proposals: [], mood: 'processing' };
        try {
          const jsonMatch = dreamText.match(/\{[\s\S]*\}/);
          if (jsonMatch) dreamReport = JSON.parse(jsonMatch[0]);
        } catch {}

        // Write to dreams.ndjson
        const dreamEntry = _dream.writeDream(dreamReport, memDir);

        // File any proposals to the proposals system
        if (_memstore && dreamReport.proposals && dreamReport.proposals.length) {
          for (const p of dreamReport.proposals.slice(0, 2)) {
            try {
              _memstore.appendFact({
                topic: 'proposal:dream',
                fact: JSON.stringify({ title: p.title, description: p.description, priority: p.priority || 'medium', source: 'dream' }),
                source: 'dream_protocol',
                confidence: 'inferred',
              }, memDir);
            } catch {}
          }
        }

        send('dream', {
          pulseCount,
          mood: dreamReport.mood,
          patternCount: dreamReport.patterns.length,
          proposalCount: dreamReport.proposals.length,
          ts: dreamEntry.ts,
        });

      } catch (e) {
        // Dream failures are silent — don't disrupt the pulse
      }
    }
  } catch (_) {}
}
// Fire once after 5s (so context is established), then on interval
setTimeout(runPulse, 5000);
setInterval(runPulse, PULSE_INTERVAL);

// Startup briefing: ATLAS orients itself and greets Daniel ~2s after startup
setTimeout(() => runStartupBriefing().catch(() => {}), 2000);

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

// Auto-execute deferred tasks from prior sessions
async function runDeferredTasks() {
  if (!_deferred) return;
  const memDir = path.join(REPO, 'memory');
  const MAX_DEFERRED = 3; // safety cap — don't auto-run more than 3 tasks at startup
  try {
    const pending = _deferred.popPending(memDir);
    if (!pending || !pending.length) return;
    const toRun = pending.slice(0, MAX_DEFERRED);
    send('startup_tasks', { count: toRun.length, tasks: toRun.map(t => t.task.slice(0, 60)) });
    for (let i = 0; i < toRun.length; i++) {
      const entry = toRun[i];
      const mode = entry.mode || 'read';
      send('deferred_exec', { task: entry.task, mode, count: i + 1 });
      await runSubagent(
        `[DEFERRED TASK from prior session]\nReason it was deferred: ${entry.reason || 'scheduled'}\n\nTask:\n${entry.task}`,
        mode,
        20 * 60 * 1000,
        null
      );
    }
  } catch (e) {
    send('deferred_error', { error: e.message });
  }
}
// Execute deferred tasks from previous sessions — fires 5s after startup to let briefing go first
setTimeout(() => runDeferredTasks().catch(() => {}), 5000);

// Broadcast unread notifications from previous sessions
try {
  const unread = _notif ? _notif.getUnread(path.join(REPO, 'memory')) : [];
  if (unread.length) unread.forEach(n => send('notification', n));
} catch (_) {}

// Mark all notifications read 10s after startup (show once per session)
try {
  setTimeout(() => { if (_notif) _notif.markRead('*', path.join(REPO, 'memory')); }, 10000);
} catch (_) {}
