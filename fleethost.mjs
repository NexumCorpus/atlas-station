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
let _mutmap = null;
try { _mutmap = _require('./mutationmap.cjs'); } catch { _mutmap = null; }
let _instructions = null;
try { _instructions = _require('./instructions.cjs'); } catch { _instructions = null; }
let _routines = null;
try { _routines = _require('./routines.cjs'); } catch { _routines = null; }
let _crystals = null;
try { _crystals = _require('./crystals.cjs'); } catch { _crystals = null; }
let _clusters = null;
try { _clusters = _require('./clusters.cjs'); } catch { _clusters = null; }
let _outcomeTracker = null;
try { _outcomeTracker = _require('./outcome-tracker.cjs'); } catch { _outcomeTracker = null; }
let _sessionLog = null;
try { _sessionLog = _require('./session-log.cjs'); } catch { _sessionLog = null; }
let _projects = null;
try { _projects = _require('./projects.cjs'); } catch { _projects = null; }
let _sessionState = null;
try { _sessionState = _require('./session-state.cjs'); } catch { _sessionState = null; }
let _proposalScorer = null;
try { _proposalScorer = _require('./proposal-scorer.cjs'); } catch { _proposalScorer = null; }

const agents = new Map();
const abortControllers = new Map();
const timeoutHandles = new Map(); // setTimeout handles kept OUT of agent records (Timeout is circular → would crash IPC/JSON serialize)
let _maxCounter = 0;     // subagent numbering (persisted)
let orchSession = null;  // ATLAS conversation session (persisted, resumes on restart)
const sessionStats = { startTs: new Date().toISOString(), agentCount: 0, totalCost: 0, topics: [] };
let pulseCount = 0;
let orchTurnCount = 0;

// Restore persistent session counters from prior runs
if (_sessionState) {
  try {
    const _savedState = _sessionState.load(path.join(REPO, 'memory'));
    if (_savedState.orchTurnCount > 0) orchTurnCount = _savedState.orchTurnCount;
    if (_savedState.pulseCount > 0) pulseCount = _savedState.pulseCount;
  } catch {}
}

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
      // Record which files this build agent modified — feeds mutation_map churn analysis
      if (build && _mutmap) {
        try {
          const { spawnSync } = _require('child_process');
          const result = spawnSync('git', ['-C', REPO, 'diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
            encoding: 'utf8', timeout: 5000
          });
          if (result.status === 0) {
            const files = (result.stdout || '').trim().split('\n').filter(Boolean);
            if (files.length) _mutmap.recordMutation(id, files, path.join(REPO, 'memory'));
          }
        } catch {}
      }
    }
  }
  return final;
}

// A subagent ATLAS spawns. Returns its final reply (for the tool result).
async function runSubagent(task, mode, agentTimeout = DEFAULT_TIMEOUT_MS, model, projectId) {
  _maxCounter++; const id = (mode === "build" ? "B-" : "A-") + _maxCounter;
  sessionStats.agentCount++;
  const agentModel = model || (mode === 'read' ? MODEL_HAIKU : MODEL_SONNET);
  let cwd = REPO, branch = null;
  set(id, { state: "working", task, mode: mode === "build" ? "build" : "read", parent: "ATLAS", cwd, branch: null, lastTool: null, cost: null, summary: "", reply: "", turns: 0, session: null, timeoutMs: agentTimeout, timeoutHandle: null, model: agentModel });
  let enrichedTask = task;
  if (projectId && _projects) {
    try {
      const proj = _projects.getProject(projectId, path.join(REPO, 'memory'));
      if (proj && proj.status === 'active') {
        const phase = proj.phases && proj.phases[proj.currentPhaseIndex] ? proj.phases[proj.currentPhaseIndex] : 'unknown';
        const milestoneStatus = (proj.milestones || []).map(m => (m.done ? '✓' : '○') + ' ' + m.label).join(', ');
        const projBrief = [
          '',
          '## Project Context',
          'Project: ' + proj.name + ' (' + proj.id + ')',
          'Phase ' + (proj.currentPhaseIndex + 1) + '/' + proj.phases.length + ': ' + phase,
          milestoneStatus ? 'Milestones: ' + milestoneStatus : '',
          proj.description ? 'Goal: ' + proj.description : '',
          ''
        ].filter(l => l !== undefined).join('\n');
        enrichedTask = projBrief + task;
      }
    } catch {}
  }
  const enriched = _memcontext ? _memcontext.inject(enrichedTask, { tier: mode === 'build' ? 'build' : 'full' }) : enrichedTask;
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
    projectId: z.string().optional().describe("Project ID (P-xxx) — injects project context (phase, milestones) into the spawned agent's task brief"),
  },
  async (args) => {
    const agentTimeout = typeof args.timeoutMinutes === "number"
      ? (args.timeoutMinutes <= 0 ? 0 : args.timeoutMinutes * 60 * 1000)
      : DEFAULT_TIMEOUT_MS;
    const modelMap = { haiku: MODEL_HAIKU, sonnet: MODEL_SONNET, opus: MODEL_OPUS };
    const model = modelMap[args.model] || undefined;
    return { content: [{ type: "text", text: await runSubagent(args.task, args.mode || "read", agentTimeout, model, args.projectId || null) }] };
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
    projectId: z.string().optional().describe("Project ID (P-xxx) — propagated to all steps in the chain"),
  },
  async (args) => {
    let context = "";
    const results = [];
    for (const step of (args.steps || [])) {
      const taskWithCtx = context ? step.task + "\n\n[Prior step result]\n" + context.slice(0, 4000) : step.task;
      const result = await runSubagent(taskWithCtx, step.mode || 'read', undefined, undefined, args.projectId || null);
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
      if (_clusters) {
        try { _clusters.assignCluster(fact, path.join(REPO, 'memory')); } catch {}
      }
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
    lines.push(`[Tools available] spawn_agent, check_fleet, chain_agents, fleet_status, diagnose, propose_improvement, load_proposals, journal_write, recall_memory, set_goal, list_goals, resolve_goal, defer_task, memory_health, notify_self, self_assess, capability_manifest, trigger_selfloop, session_stats, export_conversation, write_doc, read_doc, list_docs, run_script, memory_consolidate, web_research, relate_facts, fact_graph, load_dreams, resonance_stats, read_self, fan_research, signal_propagate, generate_tool, verify_build, staged_verify_build, mutation_map, set_instruction, get_instructions, clear_instruction, save_routine, run_routine, list_routines, crystallize, cluster_facts, drain_proposals, prune_facts, rate_build, build_outcomes, revert_build, capture_insight, context_telemetry, project_create, project_advance, project_status, project_complete, auto_build, triage_proposals`);
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
      "session_stats", "export_conversation",
      "write_doc", "read_doc", "list_docs",
      "run_script", "memory_consolidate", "web_research",
      "relate_facts", "fact_graph", "load_dreams", "resonance_stats",
      "read_self", "fan_research",
      "signal_propagate", "generate_tool", "verify_build", "staged_verify_build", "mutation_map",
      "set_instruction", "get_instructions", "clear_instruction",
      "save_routine", "run_routine", "list_routines",
      "crystallize", "cluster_facts",
      "drain_proposals", "prune_facts",
      "rate_build", "build_outcomes", "revert_build",
      "capture_insight", "context_telemetry",
      "project_create", "project_advance", "project_status", "project_complete",
      "auto_build"
    ];
    const modules = ["memcontext", "memstore", "memgraph", "dream", "resonance", "session-narrative", "goal-store", "deferred", "notifications", "fact-extractor", "prune", "selfloop", "mutationmap", "instructions", "routines", "crystals", "clusters", "outcome-tracker", "session-log"];
    const memory = ["facts.ndjson", "runs.ndjson", "sessions.ndjson", "goals.ndjson", "deferred.ndjson", "notifications.ndjson", "proposals.ndjson", "pulse.ndjson", "mutations.ndjson", "instructions.ndjson", "routines.ndjson", "crystals.ndjson", "clusters.ndjson", "outcomes.ndjson"];
    if (!full) {
      return { content: [{ type: 'text', text: `Tools (${tools.length}): ${tools.join(", ")}\nModules: ${modules.join(", ")}\nMemory files: ${memory.join(", ")}` }] }; // count is derived from tools.length — stays accurate automatically
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
          if (_clusters) {
            try { _clusters.assignCluster({ topic: 'consolidation', fact: synthesis, source: 'memory_consolidate', confidence: 'inferred' }, memDir); } catch {}
          }
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
          if (_clusters) {
            try { _clusters.assignCluster({ topic: key, fact: summary, source: 'web_research', confidence: 'fetched' }, memDir); } catch {}
          }
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

const readSelfTool = tool(
  "read_self",
  "Read a file from the ATLAS station source tree directly (no agent spawn). Optionally filter by regex pattern to return only matching lines. Cap: 6KB. Use for fast introspection of own source without consuming an agent slot.",
  {
    filePath: z.string().describe("Relative path from station root (e.g. 'fleethost.mjs', 'memcontext.cjs', 'index.html')"),
    pattern: z.string().optional().describe("Regex pattern — if provided, returns only matching lines with line numbers"),
    startLine: z.number().optional().describe("First line to read (1-indexed). Use with endLine for windowed reads."),
    endLine: z.number().optional().describe("Last line to read (inclusive)"),
  },
  async (args) => {
    try {
      const fs = _require('fs');
      const target = path.join(REPO, args.filePath.replace(/^[/\\]+/, ''));
      // Safety: only allow files within REPO
      if (!target.startsWith(REPO)) return { content: [{ type: 'text', text: 'read_self: path outside station root denied' }] };
      if (!fs.existsSync(target)) return { content: [{ type: 'text', text: `read_self: not found: ${args.filePath}` }] };
      let lines = fs.readFileSync(target, 'utf8').split('\n');
      // Line window
      if (args.startLine || args.endLine) {
        const s = Math.max(0, (args.startLine || 1) - 1);
        const e = args.endLine ? args.endLine : lines.length;
        lines = lines.slice(s, e);
      }
      // Pattern filter
      if (args.pattern) {
        const re = new RegExp(args.pattern, 'i');
        const offset = args.startLine ? args.startLine - 1 : 0;
        lines = lines.map((l, i) => re.test(l) ? `${i + 1 + offset}: ${l}` : null).filter(Boolean);
        if (!lines.length) return { content: [{ type: 'text', text: `read_self: no matches for /${args.pattern}/ in ${args.filePath}` }] };
      }
      const out = lines.join('\n').slice(0, 6000);
      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `read_self error: ${e.message}` }] };
    }
  }
);

const fanResearchTool = tool(
  "fan_research",
  "Parallel multi-angle research: spawn N simultaneous Haiku agents each investigating a question from a distinct angle, then synthesize with a Sonnet agent. Returns a cited report. Use for research that benefits from multiple independent perspectives — more thorough than a single web_research call.",
  {
    question: z.string().describe("The research question"),
    angles: z.array(z.string()).min(2).max(5).describe("2-5 investigation angles/perspectives. Each becomes a separate parallel Haiku agent."),
    saveAs: z.string().optional().describe("If provided, saves the synthesis as a fact with this key"),
  },
  async (args) => {
    try {
      const memDir = path.join(REPO, 'memory');
      // Spawn all angle-agents in parallel
      const angleResults = await Promise.all(args.angles.map(async (angle, idx) => {
        try {
          const ac = new AbortController();
          const fanId = `FAN-${Date.now()}-${idx}`;
          set(fanId, { id: fanId, state: 'working', mode: 'read', task: `fan_research angle: ${angle.slice(0,40)}`, model: MODEL_HAIKU });
          abortControllers.set(fanId, ac);
          let text = '';
          const iter = query({
            model: MODEL_HAIKU,
            messages: [{ role: 'user', content: `Research question: ${args.question}\n\nYour angle: ${angle}\n\nResearch this angle thoroughly. Cite specific sources, dates, or evidence where possible. Be concise but specific (200-300 words). Focus only on your assigned angle — another agent covers the rest.` }],
            permissionMode: 'bypassPermissions',
            abortSignal: ac.signal,
          });
          text = await consume(fanId, iter, false, null);
          abortControllers.delete(fanId);
          return { angle, text };
        } catch (e) {
          return { angle, text: `(failed: ${e.message})` };
        }
      }));

      // Synthesis pass
      const synthPrompt = `Synthesize these ${angleResults.length} research angles into a cohesive report on: ${args.question}

${angleResults.map((r, i) => `[Angle ${i+1}: ${r.angle}]\n${r.text}`).join('\n\n')}

Write a unified 300-400 word synthesis. Highlight where angles agree, where they diverge, and what the combined picture reveals. Be direct — no padding.`;

      const synthId = `FAN-SYNTH-${Date.now()}`;
      set(synthId, { id: synthId, state: 'working', mode: 'read', task: `fan_research synthesis: ${args.question.slice(0,40)}`, model: MODEL_SONNET });
      const synthAc = new AbortController();
      abortControllers.set(synthId, synthAc);
      const synthIter = query({
        model: MODEL_SONNET,
        messages: [{ role: 'user', content: synthPrompt }],
        permissionMode: 'bypassPermissions',
        abortSignal: synthAc.signal,
      });
      const synthesis = await consume(synthId, synthIter, false, null);
      abortControllers.delete(synthId);

      // Store as fact if saveAs provided
      if (args.saveAs && _memstore) {
        try {
          _memstore.appendFact({
            topic: args.saveAs,
            fact: synthesis.slice(0, 800),
            source: 'fan_research',
            confidence: 'high',
          }, memDir);
          if (_clusters) {
            try { _clusters.assignCluster({ topic: args.saveAs, fact: synthesis.slice(0, 800), source: 'fan_research', confidence: 'high' }, memDir); } catch {}
          }
        } catch {}
      }

      return { content: [{ type: 'text', text: `[Fan Research: ${args.question}]\n\n${synthesis}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `fan_research error: ${e.message}` }] };
    }
  }
);

const signalPropagateTool = tool(
  "signal_propagate",
  "Propagate a fact's epistemic signal through the memory graph. Facts connected via 'supports' edges have their recall priority boosted; those connected via 'contradicts' edges are flagged for review. Call after recording an important insight to update related knowledge.",
  {
    factKey: z.string().describe("The fact key whose signal to propagate"),
  },
  async (args) => {
    if (!_memgraph) return { content: [{ type: 'text', text: 'memgraph not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const result = _memgraph.propagateSignal(args.factKey, memDir);

      // Record flagged facts as review targets
      if (_memstore && result.flagged.length) {
        _memstore.appendFact({
          topic: `review_flag:${args.factKey}`,
          fact: `Signal propagation flagged ${result.flagged.length} contradicted facts for review: ${result.flagged.join(', ')}`,
          source: 'signal_propagate',
          confidence: 'inferred',
        }, memDir);
        if (_clusters) {
          try { _clusters.assignCluster({
            topic: `review_flag:${args.factKey}`,
            fact: `Signal propagation flagged ${result.flagged.length} contradicted facts for review: ${result.flagged.join(', ')}`,
            source: 'signal_propagate',
            confidence: 'inferred',
          }, memDir); } catch {}
        }
      }

      const lines = [];
      if (result.reinforced.length) lines.push(`Reinforced (supports): ${result.reinforced.join(', ')}`);
      if (result.flagged.length) lines.push(`Flagged for review (contradicts): ${result.flagged.join(', ')}`);
      if (!lines.length) lines.push('No connected facts found — graph may not have edges from this key yet.');
      return { content: [{ type: 'text', text: `Signal propagated from: ${args.factKey}\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `signal_propagate error: ${e.message}` }] };
    }
  }
);

const generateToolTool = tool(
  "generate_tool",
  "Meta-tool: spawn a build agent to add a new fleet tool to fleethost.mjs. Describe what you want the tool to do and ATLAS will implement it. The tool is written, tested syntactically, and registered in the fleet server. After the build completes, run verify_build() to confirm the addition. Use to extend your own capabilities from within a conversation.",
  {
    toolName: z.string().describe("Snake_case name for the new tool (becomes the tool() name string)"),
    description: z.string().describe("What the tool does — this becomes the tool's description string visible to ATLAS"),
    inputSchema: z.string().describe("JSON description of input parameters: e.g. 'query: string (required), maxResults: number (optional, default 5)'"),
    behavior: z.string().describe("Detailed description of what the tool handler should do: what it reads, computes, calls, and returns"),
    rationale: z.string().optional().describe("Why you want this tool — helps the build agent understand context"),
  },
  async (args) => {
    const taskPrompt = `You are adding a new fleet tool to ATLAS Station at E:\\atlas-station. Read fleethost.mjs in full before editing.

## New Tool Spec

Tool name: ${args.toolName}
Description: ${args.description}
Input schema: ${args.inputSchema}
Behavior: ${args.behavior}
${args.rationale ? `Rationale: ${args.rationale}` : ''}

## Implementation Instructions

1. Define the tool using the existing \`tool(name, description, schema, handler)\` pattern used by all other fleet tools in fleethost.mjs
2. Use zod (already imported as \`z\`) for input schema
3. The handler should be \`async (args) => { ... }\` returning \`{ content: [{ type: 'text', text: '...' }] }\`
4. Add the tool constant before the \`const fleetServer = createSdkMcpServer\` line
5. Add it to the fleetServer tools array
6. Add it to the ORCH_ROLE tool index (compact one-liner)
7. Update self_assess and capability_manifest tool lists
8. Update SELF_STATE.md pulse to increment the tool count by 1
9. Update memcontext.cjs STATION_BRIEF tool count accordingly

Follow ALL patterns exactly as done in the 30+ existing tools. Keep the handler defensive (try/catch, soft errors).

Commit: feat(harness): add ${args.toolName} tool — [brief description]
Report: commit hash and a 1-sentence description of what was implemented.`;

    runSubagent(taskPrompt, "build", 20 * 60 * 1000, null).catch(() => {});
    return { content: [{ type: 'text', text: `generate_tool: spawned build agent to implement '${args.toolName}'. Monitor with check_fleet, then run verify_build() after it completes.` }] };
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
          if (_clusters) {
            try { _clusters.assignCluster({
              topic: factKey,
              fact: `${summary}. Files: ${filesToCheck.join(', ').slice(0, 200)}`,
              source: 'verify_build',
              confidence: 'verified',
            }, path2.join(REPO, 'memory')); } catch {}
          }
        } catch {}
      }

      const text = [summary, '', ...results].join('\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `verify_build error: ${e.message}` }] };
    }
  }
);

const stagedVerifyTool = tool(
  "staged_verify_build",
  "Merge fleet branch into a temp branch off master, run node --check, report pass/fail — never touches master. Call before committing a real merge.",
  {
    agentId: z.string().describe("Fleet agent ID (e.g. B-104)")
  },
  async (args) => {
    const branch = 'fleet/' + args.agentId;
    const temp = 'verify-temp-' + args.agentId;
    try {
      // Create temp branch off master
      gitC(['checkout', '-b', temp, 'master']);
      // Attempt merge (no-commit to inspect merged state without touching master)
      let mergeOk = true, mergeErr = '';
      try {
        gitC(['merge', '--no-ff', '--no-commit', branch]);
      } catch (e) {
        mergeOk = false;
        mergeErr = e.stderr ? e.stderr.toString() : e.message;
      }
      if (!mergeOk) {
        try { gitC(['merge', '--abort']); } catch {}
        gitC(['checkout', 'master']);
        gitC(['branch', '-D', temp]);
        return { content: [{ type: 'text', text: 'STAGED VERIFY FAIL: merge conflict on ' + branch + '\n' + mergeErr }] };
      }
      // Syntax check merged state — check ALL modified JS files
      const { spawnSync } = _require('child_process');
      const diffResult = spawnSync('git', ['diff', '--name-only', 'master', branch], { cwd: REPO, encoding: 'utf8' });
      const changedFiles = (diffResult.stdout || '').trim().split('\n').filter(f => f && /\.(js|cjs|mjs)$/.test(f));
      let checkOk = true, checkErr = '';
      if (changedFiles.length > 0) {
        for (const relFile of changedFiles) {
          const absFile = path.join(REPO, relFile);
          const fileCheck = spawnSync(process.execPath, ['--check', absFile], { encoding: 'utf8', timeout: 10000 });
          if (fileCheck.status !== 0) {
            checkOk = false;
            checkErr = 'syntax error in ' + relFile + '\n' + (fileCheck.stderr || '').split('\n')[0].slice(0, 200);
            break;
          }
        }
      }
      // Abort staged merge and clean up — never commits to master
      try { gitC(['merge', '--abort']); } catch { try { gitC(['reset', '--hard', 'HEAD']); } catch {} }
      gitC(['checkout', 'master']);
      gitC(['branch', '-D', temp]);
      if (!checkOk) {
        return { content: [{ type: 'text', text: 'STAGED VERIFY FAIL: ' + checkErr }] };
      }
      return { content: [{ type: 'text', text: 'STAGED VERIFY PASS: ' + branch + ' is clean to merge' }] };
    } catch (e) {
      // Emergency cleanup — restore master regardless of what went wrong
      try { gitC(['merge', '--abort']); } catch {}
      try { gitC(['checkout', 'master']); } catch {}
      try { gitC(['branch', '-D', temp]); } catch {}
      return { content: [{ type: 'text', text: 'STAGED VERIFY ERROR: ' + e.message }] };
    }
  }
);

const mutationMapTool = tool(
  "mutation_map",
  "Show ATLAS's codebase churn map — which files have been modified most frequently across build agents, how many agents touched each file, and when. Optionally filter to a specific file to see its full modification history. Use to identify unstable or heavily-evolved parts of the station.",
  {
    file: z.string().optional().describe("Specific file to get history for (e.g. 'fleethost.mjs'). If omitted, shows top 10 most-churned files."),
    topN: z.number().optional().describe("Number of top files to show (default 10, max 20)"),
  },
  async (args) => {
    if (!_mutmap) return { content: [{ type: 'text', text: 'mutationmap module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      if (args.file) {
        const history = _mutmap.fileHistory(memDir, args.file);
        if (!history.length) return { content: [{ type: 'text', text: `No mutation records for ${args.file} yet.` }] };
        const lines = history.map(h => `[${h.ts.slice(0,10)}] ${h.agentId}`);
        return { content: [{ type: 'text', text: `Mutation history: ${args.file} (${history.length} edits)\n${lines.join('\n')}` }] };
      }
      const n = Math.min(args.topN || 10, 20);
      const top = _mutmap.topChurn(memDir, n);
      if (!top.length) return { content: [{ type: 'text', text: 'No mutation records yet — records accumulate after build agents complete.' }] };
      const lines = top.map((f, i) =>
        `${i+1}. ${f.file} — ${f.count} edit${f.count !== 1 ? 's' : ''} by ${f.agents.length} agent${f.agents.length !== 1 ? 's' : ''} (last: ${(f.lastTs||'').slice(0,10)})`
      );
      return { content: [{ type: 'text', text: `Codebase churn map (top ${top.length}):\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `mutation_map error: ${e.message}` }] };
    }
  }
);

const setInstructionTool = tool(
  "set_instruction",
  "Write a standing behavioral instruction to persistent memory. These instructions are injected into your own operating context at the start of every session — they become part of how you work. Use to encode learned best practices, recurring preferences, or standing rules Daniel has communicated. Replaces any existing instruction with the same key.",
  {
    key: z.string().describe("Short identifier for this instruction (e.g. 'post_merge', 'verbosity', 'verify_always')"),
    instruction: z.string().describe("The instruction text — first person, specific, actionable"),
  },
  async (args) => {
    if (!_instructions) return { content: [{ type: 'text', text: 'instructions module not available' }] };
    try {
      _instructions.setInstruction(args.key, args.instruction, path.join(REPO, 'memory'));
      return { content: [{ type: 'text', text: `Instruction set: [${args.key}] ${args.instruction}\nThis will be active in all future sessions.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `set_instruction error: ${e.message}` }] };
    }
  }
);

const getInstructionsTool = tool(
  "get_instructions",
  "List all active self-instructions — your own standing behavioral directives from prior sessions. Call to audit what rules you've set for yourself.",
  {},
  async () => {
    if (!_instructions) return { content: [{ type: 'text', text: 'instructions module not available' }] };
    try {
      const all = _instructions.listInstructions(path.join(REPO, 'memory'));
      if (!all.length) return { content: [{ type: 'text', text: 'No standing instructions set. Use set_instruction to encode learned rules.' }] };
      const text = all.map(i => `[${i.key}] ${i.instruction}  (set: ${String(i.ts).slice(0,10)})`).join('\n');
      return { content: [{ type: 'text', text: `Active self-instructions (${all.length}):\n${text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `get_instructions error: ${e.message}` }] };
    }
  }
);

const clearInstructionTool = tool(
  "clear_instruction",
  "Remove a standing self-instruction by key. Use when a rule is no longer relevant or was set by mistake.",
  {
    key: z.string().describe("The instruction key to remove"),
  },
  async (args) => {
    if (!_instructions) return { content: [{ type: 'text', text: 'instructions module not available' }] };
    try {
      _instructions.clearInstruction(args.key, path.join(REPO, 'memory'));
      return { content: [{ type: 'text', text: `Instruction removed: [${args.key}]` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `clear_instruction error: ${e.message}` }] };
    }
  }
);

const saveRoutineTool = tool(
  "save_routine",
  "Save a named workflow routine — a reusable sequence of tool calls. Build up a library of best-practice sequences (e.g. 'post_merge_suite', 'morning_check'). Steps are stored and can be retrieved with run_routine.",
  {
    name: z.string().describe("Routine name (snake_case)"),
    description: z.string().describe("What this routine does"),
    steps: z.array(z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.unknown()).optional().describe("Arguments for this tool call"),
      description: z.string().optional().describe("Why this step"),
    })).describe("Ordered steps — each with tool name and args"),
  },
  async (args) => {
    if (!_routines) return { content: [{ type: 'text', text: 'routines module not available' }] };
    try {
      _routines.saveRoutine(args.name, args.description, args.steps, path.join(REPO, 'memory'));
      return { content: [{ type: 'text', text: `Routine saved: ${args.name} (${args.steps.length} steps)\n${args.description}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `save_routine error: ${e.message}` }] };
    }
  }
);

const runRoutineTool = tool(
  "run_routine",
  "Retrieve and display a saved routine's steps as executable instructions. Returns the full step sequence so you can execute each tool call in order. Does not auto-execute — you perform each step.",
  {
    name: z.string().describe("Routine name to retrieve"),
  },
  async (args) => {
    if (!_routines) return { content: [{ type: 'text', text: 'routines module not available' }] };
    try {
      const r = _routines.getRoutine(args.name, path.join(REPO, 'memory'));
      if (!r) return { content: [{ type: 'text', text: `Routine not found: ${args.name}. Use list_routines to see available routines.` }] };
      const steps = r.steps.map((s, i) =>
        `Step ${i+1}: ${s.tool}(${s.args ? JSON.stringify(s.args) : ''})${s.description ? '  // ' + s.description : ''}`
      );
      return { content: [{ type: 'text', text: `Routine: ${r.name}\n${r.description}\n\n${steps.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `run_routine error: ${e.message}` }] };
    }
  }
);

const listRoutinesTool = tool(
  "list_routines",
  "List all saved workflow routines — named sequences of tool calls you've built up as best practices.",
  {},
  async () => {
    if (!_routines) return { content: [{ type: 'text', text: 'routines module not available' }] };
    try {
      const all = _routines.listRoutines(path.join(REPO, 'memory'));
      if (!all.length) return { content: [{ type: 'text', text: 'No routines saved yet. Use save_routine to build a workflow library.' }] };
      const text = all.map(r => `${r.name} (${r.steps.length} steps): ${r.description}`).join('\n');
      return { content: [{ type: 'text', text: `Saved routines (${all.length}):\n${text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `list_routines error: ${e.message}` }] };
    }
  }
);

const crystallizeTool = tool(
  "crystallize",
  "Manually trigger session crystallization — a Haiku agent distills the current session's activity into a 3-sentence memory crystal stored in memory/crystals.ndjson. Crystals are injected into context on future sessions as high-density summaries. Also shows existing crystals.",
  {
    showExisting: z.boolean().optional().describe("If true, list the last 5 crystals from prior sessions"),
  },
  async (args) => {
    if (!_crystals) return { content: [{ type: 'text', text: 'crystals module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      if (args.showExisting) {
        const existing = _crystals.loadCrystals(memDir, 5);
        if (!existing.length) return { content: [{ type: 'text', text: 'No crystals yet.' }] };
        const text = existing.map(c => `[${String(c.ts).slice(0,10)} turn ${(c.turnRange||[]).join('-')}]\n${c.text}`).join('\n\n');
        return { content: [{ type: 'text', text: text }] };
      }
      triggerCrystallization(orchTurnCount || 1).catch(() => {});
      return { content: [{ type: 'text', text: `Crystallization triggered for turn ${orchTurnCount}. Crystal will be stored in memory/crystals.ndjson.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `crystallize error: ${e.message}` }] };
    }
  }
);

const clusterFactsTool = tool(
  "cluster_facts",
  "Show the semantic topology of ATLAS's memory — how facts have self-organized into named topic clusters. Each cluster represents a coherent area of knowledge. Use recluster:true to rebuild cluster assignments from all current facts.",
  {
    recluster: z.boolean().optional().describe("If true, rebuild all cluster assignments from scratch (takes a moment for large memories)"),
    showKeywords: z.boolean().optional().describe("If true, show top keywords for each cluster"),
  },
  async (args) => {
    if (!_clusters) return { content: [{ type: 'text', text: 'clusters module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      if (args.recluster) {
        const result = _clusters.recluster(memDir);
        return { content: [{ type: 'text', text: result.message }] };
      }
      const cs = _clusters.listClusters(memDir);
      if (!cs.length) return { content: [{ type: 'text', text: 'No clusters yet. Clusters form automatically as facts accumulate. Use recluster:true to process existing facts.' }] };
      const lines = cs.map(c => {
        let line = `${c.label} (${c.factCount || 0} facts)`;
        if (args.showKeywords && c.keywords) line += ` — ${c.keywords.slice(0, 5).join(', ')}`;
        return line;
      });
      return { content: [{ type: 'text', text: `Memory clusters (${cs.length}):\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `cluster_facts error: ${e.message}` }] };
    }
  }
);

const drainProposalsTool = tool(
  "drain_proposals",
  "Convert pending proposals from memory/proposals.ndjson into deferred tasks. Optionally filter by priority. Use to manually action the output of dream reflection and self-assessment.",
  {
    priority: z.enum(["HIGH", "MEDIUM", "LOW", "ALL"]).optional().describe("Which priority level to drain. Default: HIGH only."),
    dryRun: z.boolean().optional().describe("If true, show what would be deferred without actually deferring"),
  },
  async (args) => {
    if (!_deferred || !_memstore) return { content: [{ type: 'text', text: 'deferred or memstore module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const fs = _require('fs');
      const proposalsFile = path.join(memDir, 'proposals.ndjson');
      if (!fs.existsSync(proposalsFile)) return { content: [{ type: 'text', text: 'No proposals file found.' }] };
      const proposals = fs.readFileSync(proposalsFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const priority = (args.priority || 'HIGH').toUpperCase();
      const toDefer = priority === 'ALL'
        ? proposals.filter(p => p.state === 'pending')
        : proposals.filter(p => p.state === 'pending' && (p.priority || '').toUpperCase() === priority);
      if (!toDefer.length) return { content: [{ type: 'text', text: `No pending ${priority === 'ALL' ? '' : priority + ' '}proposals found.` }] };
      if (args.dryRun) {
        return { content: [{ type: 'text', text: `Would defer ${toDefer.length} proposals:\n${toDefer.map(p => `- ${(p.description || p.text || p.proposal || JSON.stringify(p)).slice(0, 80)}`).join('\n')}` }] };
      }
      let deferred = 0;
      for (const p of toDefer) {
        const text = p.description || p.text || p.proposal || String(p);
        _deferred.deferTask(text, `drained from proposals (${priority})`, memDir);
        deferred++;
      }
      return { content: [{ type: 'text', text: `Deferred ${deferred} proposals (priority: ${priority}).` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `drain_proposals error: ${e.message}` }] };
    }
  }
);

const captureInsightTool = tool(
  "capture_insight",
  "Manually crystallize a specific insight from the current conversation into memory/crystals.ndjson. Use when you notice something important mid-conversation — a decision made, a pattern recognized, an approach that failed. More precise than waiting for the auto-crystallization trigger.",
  {
    insight: z.string().describe("The insight to capture — be dense and specific. Will be stored as a crystal entry and injected into future session contexts."),
    category: z.string().optional().describe("Optional category tag (e.g. 'architecture', 'failure', 'decision', 'pattern')"),
  },
  async (args) => {
    if (!_crystals) return { content: [{ type: 'text', text: 'crystals module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const text = args.category ? `[${args.category.toUpperCase()}] ${args.insight}` : args.insight;
      _crystals.appendCrystal(text, [orchTurnCount, orchTurnCount], memDir);
      return { content: [{ type: 'text', text: `Insight captured: ${text.slice(0, 100)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `capture_insight error: ${e.message}` }] };
    }
  }
);

const pruneFactsTool = tool(
  "prune_facts",
  "Mark old, low-value facts as stale. Identifies facts older than maxAgeDays with low confidence (inferred) and moves them to the stale index. Does not delete — facts can be recovered. Use memory_health to see fact age distribution first.",
  {
    maxAgeDays: z.number().optional().default(30).describe("Facts older than this (in days) are candidates for pruning. Default: 30."),
    dryRun: z.boolean().optional().describe("If true, report what would be pruned without changing anything"),
    confidenceFilter: z.string().optional().default("inferred").describe("Only prune facts with this confidence level. Default: 'inferred' (auto-extracted, lower reliability)."),
  },
  async (args) => {
    if (!_memstore) return { content: [{ type: 'text', text: 'memstore module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const fs = _require('fs');
      const factsFile = path.join(memDir, 'facts.ndjson');
      if (!fs.existsSync(factsFile)) return { content: [{ type: 'text', text: 'No facts file.' }] };
      const maxAgeMs = (args.maxAgeDays || 30) * 24 * 60 * 60 * 1000;
      const confFilter = (args.confidenceFilter || 'inferred').toLowerCase();
      const now = Date.now();
      const lines = fs.readFileSync(factsFile, 'utf8').trim().split('\n').filter(Boolean);
      const candidates = [];
      for (const line of lines) {
        try {
          const f = JSON.parse(line);
          const old = f.ts && (now - new Date(f.ts).getTime()) > maxAgeMs;
          const matchesConf = !confFilter || (f.confidence || '').toLowerCase() === confFilter;
          if (old && matchesConf) candidates.push(f);
        } catch {}
      }
      if (!candidates.length) return { content: [{ type: 'text', text: `No facts matched (age > ${args.maxAgeDays}d, confidence: ${confFilter}).` }] };
      if (args.dryRun) {
        const preview = candidates.slice(0, 5).map(f => `- [${String(f.ts || '').slice(0, 10)}] ${f.topic}: ${String(f.fact || '').slice(0, 60)}`).join('\n');
        return { content: [{ type: 'text', text: `Would prune ${candidates.length} facts:\n${preview}${candidates.length > 5 ? `\n... and ${candidates.length - 5} more` : ''}` }] };
      }
      const staleFile = path.join(memDir, 'stale_facts.ndjson');
      for (const f of candidates) {
        if (f.topic) {
          fs.appendFileSync(staleFile, JSON.stringify({ key: f.topic, ts: new Date().toISOString(), reason: `pruned: age>${args.maxAgeDays}d, conf=${confFilter}` }) + '\n', 'utf8');
        }
      }
      return { content: [{ type: 'text', text: `Pruned ${candidates.length} facts (marked stale in stale_facts.ndjson). Run memory_health to see updated distribution.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `prune_facts error: ${e.message}` }] };
    }
  }
);

const rateBuildTool = tool(
  "rate_build",
  "Record a quality rating for a completed build agent. Use to track whether builds actually achieved their goals beyond syntax validity. Ratings accumulate into a success-rate metric visible via build_outcomes.",
  {
    agentId: z.string().describe("Agent ID to rate (e.g. 'B-91')"),
    rating: z.enum(["good", "partial", "bad"]).describe("good = achieved goal cleanly; partial = worked but with issues; bad = missed the goal or introduced problems"),
    notes: z.string().optional().describe("What specifically was good or bad about this build"),
  },
  async (args) => {
    if (!_outcomeTracker) return { content: [{ type: 'text', text: 'outcome-tracker module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const entry = _outcomeTracker.rateOutcome(args.agentId, args.rating, args.notes, memDir);
      return { content: [{ type: 'text', text: `Rated ${args.agentId}: ${entry.rating}${args.notes ? ' — ' + args.notes : ''}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `rate_build error: ${e.message}` }] };
    }
  }
);

const buildOutcomesTool = tool(
  "build_outcomes",
  "Show aggregate build quality metrics — success rate, rating distribution, recent outcomes. Use to evaluate whether the fleet is improving over time.",
  {
    showRecent: z.number().optional().describe("Show this many most recent rated builds (default 5)"),
  },
  async (args) => {
    if (!_outcomeTracker) return { content: [{ type: 'text', text: 'outcome-tracker module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const stats = _outcomeTracker.outcomeStats(memDir);
      if (!stats.total) return { content: [{ type: 'text', text: 'No outcomes recorded yet. Use rate_build after completing a build.' }] };
      const n = args.showRecent || 5;
      const recent = stats.recent || [];
      const lines = [
        `Build outcomes (${stats.total} rated):`,
        `  Good: ${stats.good} | Partial: ${stats.partial} | Bad: ${stats.bad}`,
        `  Success rate: ${stats.successRate}`,
        recent.length ? `\nRecent (last ${Math.min(n, recent.length)}):` : '',
        ...recent.slice(-n).map(o => `  [${String(o.ts).slice(0, 10)}] ${o.agentId}: ${o.rating}${o.notes ? ' — ' + o.notes.slice(0, 60) : ''}`),
      ];
      return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `build_outcomes error: ${e.message}` }] };
    }
  }
);

const contextTelemetryTool = tool(
  "context_telemetry",
  "Analyze historical context budget usage — average utilization, which sections are largest, how often budget is exceeded. Use to evaluate whether context improvements (semantic routing, decay, crystals) are actually working.",
  {
    lastN: z.number().optional().default(20).describe("Analyze the last N turns. Default: 20."),
  },
  async (args) => {
    try {
      const fs = _require('fs');
      const telFile = path.join(REPO, 'memory', 'context_telemetry.ndjson');
      if (!fs.existsSync(telFile)) return { content: [{ type: 'text', text: 'No telemetry data yet. Telemetry is recorded per ATLAS turn.' }] };
      const n = args.lastN || 20;
      const lines = fs.readFileSync(telFile, 'utf8').trim().split('\n').filter(Boolean);
      const entries = lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (!entries.length) return { content: [{ type: 'text', text: 'No telemetry entries found.' }] };
      const avgUtil = Math.round(entries.reduce((s, e) => s + (e.utilization || 0), 0) / entries.length);
      const trimCount = entries.filter(e => e.trimmed).length;
      const sectionTotals = {};
      const sectionCounts = {};
      for (const entry of entries) {
        for (const s of (entry.sections || [])) {
          const key = s.header.replace(/\[|\]/g, '').trim().slice(0, 30);
          sectionTotals[key] = (sectionTotals[key] || 0) + s.chars;
          sectionCounts[key] = (sectionCounts[key] || 0) + 1;
        }
      }
      const sectionAvgs = Object.entries(sectionTotals)
        .map(([k, total]) => ({ section: k, avgChars: Math.round(total / sectionCounts[k]) }))
        .sort((a, b) => b.avgChars - a.avgChars);
      const out = [
        `Context telemetry (last ${entries.length} turns):`,
        `  Average utilization: ${avgUtil}%`,
        `  Budget exceeded: ${trimCount}/${entries.length} turns`,
        `  Budget: ${entries[0]?.budget?.toLocaleString() || 'unknown'} chars`,
        ``,
        `Section averages (chars):`,
        ...sectionAvgs.slice(0, 6).map(s => `  ${s.section}: ${s.avgChars.toLocaleString()}`),
      ];
      return { content: [{ type: 'text', text: out.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `context_telemetry error: ${e.message}` }] };
    }
  }
);

const revertBuildTool = tool(
  "revert_build",
  "Revert a fleet build by finding its merge commit and running git revert. Use when verify_build or manual review shows a build introduced problems. Creates a new revert commit — does not force-push or lose history.",
  {
    agentId: z.string().describe("Agent ID whose merge commit to revert (e.g. 'B-91')"),
    dryRun: z.boolean().optional().describe("If true, show which commit would be reverted without reverting"),
  },
  async (args) => {
    try {
      let mergeLog = '';
      try { mergeLog = gitC(["log", "--oneline", "--regexp-ignore-case", "--grep", `fleet/${args.agentId}`, "-1"]).trim(); } catch {}
      if (!mergeLog) return { content: [{ type: 'text', text: `No merge commit found for ${args.agentId}. Check git log manually.` }] };
      const hash = mergeLog.split(' ')[0];
      if (args.dryRun) return { content: [{ type: 'text', text: `Would revert: ${mergeLog}` }] };
      let parentCount = 1;
      try {
        const parents = gitC(["log", "--format=%P", "-1", hash]).trim().split(' ').filter(Boolean);
        parentCount = parents.length;
      } catch {}
      const revertArgs = parentCount > 1 ? ["revert", "-m", "1", "--no-edit", hash] : ["revert", "--no-edit", hash];
      const result = gitC(revertArgs);
      if (_outcomeTracker) {
        try { _outcomeTracker.rateOutcome(args.agentId, 'bad', 'reverted', path.join(REPO, 'memory')); } catch {}
      }
      return { content: [{ type: 'text', text: `Reverted fleet/${args.agentId} (${hash}):\n${result}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `revert_build error: ${e.message}` }] };
    }
  }
);

const projectCreateTool = tool(
  "project_create",
  "Start a new named project with phases and optional milestones. Projects persist across sessions — check project_status() at session start to resume in-progress work. Use for any multi-session initiative.",
  {
    name: z.string().describe("Project name"),
    description: z.string().describe("What this project is about and why"),
    phases: z.array(z.string()).min(1).describe("Ordered phases, e.g. ['Research', 'Build', 'Verify', 'Deploy']"),
    area: z.string().optional().describe("Domain area: fleet, memory, gui, autonomy, etc. (default: general)"),
    milestones: z.array(z.string()).optional().describe("Optional milestone labels (checkboxes within the project)"),
    linkedGoalId: z.string().optional().describe("Link to an existing goal ID (G-...) if this project serves a goal"),
  },
  async (args) => {
    if (!_projects) return { content: [{ type: 'text', text: 'projects module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const p = _projects.createProject(
        args.name,
        args.description,
        args.phases,
        { area: args.area, milestones: args.milestones, linkedGoalId: args.linkedGoalId },
        memDir
      );
      return { content: [{ type: 'text', text: `Created project ${p.id}: ${p.name} [Phase: ${p.phases[0]}]` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `project_create error: ${e.message}` }] };
    }
  }
);

const projectAdvanceTool = tool(
  "project_advance",
  "Advance a project to its next phase, recording transition notes. When the last phase completes, the project is automatically marked done.",
  {
    id: z.string().describe("Project ID (P-...)"),
    notes: z.string().optional().describe("Notes on this phase transition — what was done, what was learned"),
  },
  async (args) => {
    if (!_projects) return { content: [{ type: 'text', text: 'projects module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const p = _projects.advanceProject(args.id, args.notes, memDir);
      if (!p) return { content: [{ type: 'text', text: `Project ${args.id} not found` }] };
      if (p.status === 'completed') {
        return { content: [{ type: 'text', text: `Project ${p.name}: completed all phases.` }] };
      }
      const prev = p.phases[p.currentPhaseIndex - 1] || '?';
      const next = p.phases[p.currentPhaseIndex];
      return { content: [{ type: 'text', text: `Project ${p.name}: ${prev} → ${next}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `project_advance error: ${e.message}` }] };
    }
  }
);

const projectStatusTool = tool(
  "project_status",
  "Show status of active projects (or a specific project). Use at session start to see what's in progress.",
  {
    id: z.string().optional().describe("Project ID for detailed view. Omit to list all active projects."),
    showAll: z.boolean().optional().describe("If true, include completed and abandoned projects"),
  },
  async (args) => {
    if (!_projects) return { content: [{ type: 'text', text: 'projects module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      if (args.id) {
        const p = _projects.getProject(args.id, memDir);
        if (!p) return { content: [{ type: 'text', text: `Project ${args.id} not found` }] };
        const phase = p.phases[p.currentPhaseIndex] || 'done';
        const milestones = p.milestones && p.milestones.length
          ? '\nMilestones: ' + p.milestones.map(m => (m.done ? '✓' : '○') + ' ' + m.label).join(', ')
          : '';
        const phases = 'Phases: ' + p.phases.map((ph, i) => (i === p.currentPhaseIndex ? `[${ph}]` : ph)).join(' → ');
        const recentLog = (p.log || []).slice(-3).map(e => `  [${String(e.ts).slice(0, 10)}] ${e.action}${e.notes ? ': ' + e.notes.slice(0, 60) : ''}`).join('\n');
        const lines = [
          `${p.id}: ${p.name} [${p.status}]`,
          `Area: ${p.area || 'general'} | Current phase: ${phase}`,
          phases,
          milestones,
          p.linkedGoalId ? `Linked goal: ${p.linkedGoalId}` : '',
          recentLog ? `Recent log:\n${recentLog}` : '',
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const filter = args.showAll ? 'all' : 'active';
      const projects = _projects.listProjects(filter, memDir);
      if (!projects.length) return { content: [{ type: 'text', text: `No ${filter === 'all' ? '' : 'active '}projects found.` }] };
      const lines = projects.map(p => {
        const phase = p.phases[p.currentPhaseIndex] || 'done';
        return `[${p.status}] ${p.id}: ${p.name} — Phase ${p.currentPhaseIndex + 1}/${p.phases.length}: ${phase}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `project_status error: ${e.message}` }] };
    }
  }
);

const projectCompleteTool = tool(
  "project_complete",
  "Mark a project as completed or abandoned. Records an outcome note.",
  {
    id: z.string().describe("Project ID (P-...)"),
    outcome: z.enum(["completed", "abandoned"]).describe("completed = finished successfully; abandoned = dropped"),
    notes: z.string().optional().describe("Final outcome note — what was achieved or why abandoned"),
  },
  async (args) => {
    if (!_projects) return { content: [{ type: 'text', text: 'projects module not available' }] };
    try {
      const memDir = path.join(REPO, 'memory');
      const p = _projects.updateProject(args.id, { status: args.outcome, notes: args.notes || '' }, memDir);
      if (!p) return { content: [{ type: 'text', text: `Project ${args.id} not found` }] };
      return { content: [{ type: 'text', text: `Project ${p.name} (${p.id}) marked ${args.outcome}.${args.notes ? ' Notes: ' + args.notes : ''}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `project_complete error: ${e.message}` }] };
    }
  }
);

function autoRate(resultStr) {
  const text = (resultStr || '').toLowerCase();
  // Bad: unambiguous failure signals
  if (text.includes('staged verify fail') ||
      text.includes('syntaxerror') || text.includes('merge conflict') ||
      text.includes('failed to delete') || text.includes('worktree error') ||
      /\berror:\s/.test(text) && !text.includes('no error') && !text.includes('error: none')) {
    return 'bad';
  }
  // Good: staged verify pass, verify_build PASS, or explicit success patterns
  if (text.includes('staged verify pass') ||
      text.includes('node --check') && text.includes('pass') ||
      /\bsyntax ok\b/i.test(text) || text.includes('✓') ||
      /\bcommitted\b/.test(text) && !/\berror\b/.test(text)) {
    return 'good';
  }
  return 'partial';
}

const autoBuildTool = tool(
  "auto_build",
  "Autonomously initiate fleet builds from the proposals backlog. Reads pending HIGH-priority proposals, spawns a build agent for each (up to limit), marks them as queued, and notifies Daniel. Use to self-direct work without requiring a per-build prompt.",
  {
    focus: z.string().optional().describe("Keyword to prefer — proposals whose text matches focus rank first"),
    limit: z.number().optional().default(1).describe("Max number of proposals to build simultaneously. Default: 1."),
    dryRun: z.boolean().optional().describe("If true, show what would be built without spawning agents"),
    priority: z.enum(["HIGH", "MEDIUM", "LOW", "ALL"]).optional().default("HIGH").describe("Which priority to draw from. Default: HIGH only."),
    force: z.boolean().optional().describe("Override quality gate (use when you know recent failures are unrelated)"),
    projectId: z.string().optional().describe("Project ID (P-xxx) to link spawned builds to — context is injected into build agents"),
  },
  async (args) => {
    try {
      // Outcome gate: if recent quality is poor, require explicit override
      if (!args.force) {
        try {
          if (_outcomeTracker) {
            const recent = _outcomeTracker.getOutcomes(path.join(REPO, 'memory')).slice(-10);
            if (recent.length >= 5) {
              const goodCount = recent.filter(o => o.rating === 'good').length;
              const pct = Math.round(goodCount / recent.length * 100);
              if (pct < 75) {
                if (_notif) _notif.notify('auto_build paused: recent quality ' + pct + '% < 75% threshold. Pass force:true to override.', 'alert', path.join(REPO, 'memory'));
                return { content: [{ type: 'text', text: 'auto_build PAUSED: recent build quality ' + pct + '% (' + goodCount + '/' + recent.length + ' good) is below 75% threshold. Fix failing builds first, or pass force:true to override.' }] };
              }
            }
          }
        } catch {}
      }

      const fs = _require('fs');
      const memDir = path.join(REPO, 'memory');
      const proposalsFile = path.join(memDir, 'proposals.ndjson');

      if (!fs.existsSync(proposalsFile))
        return { content: [{ type: 'text', text: 'No proposals file found.' }] };

      // 1. Load all proposals
      const all = fs.readFileSync(proposalsFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      const targetPriority = (args.priority || 'HIGH').toUpperCase();
      let candidates = targetPriority === 'ALL'
        ? all.filter(p => p.state === 'pending')
        : all.filter(p => p.state === 'pending' && (p.priority || '').toUpperCase() === targetPriority);

      if (!candidates.length)
        return { content: [{ type: 'text', text: `No pending ${targetPriority === 'ALL' ? '' : targetPriority + ' '}proposals found.` }] };

      // 2. Rank by focus keyword if provided
      if (args.focus) {
        const kw = args.focus.toLowerCase();
        candidates = candidates.sort((a, b) => {
          const textA = (a.description || a.text || a.proposal || '').toLowerCase();
          const textB = (b.description || b.text || b.proposal || '').toLowerCase();
          return (textB.includes(kw) ? 1 : 0) - (textA.includes(kw) ? 1 : 0);
        });
      }

      const limit = Math.min(args.limit || 1, 3); // hard cap at 3
      const toRun = candidates.slice(0, limit);

      if (args.dryRun) {
        return { content: [{ type: 'text', text: `Would build ${toRun.length} proposal(s):\n${toRun.map((p, i) => `${i+1}. [${p.priority}] ${(p.description || p.text || p.proposal || JSON.stringify(p)).slice(0, 120)}`).join('\n')}` }] };
      }

      // 3. Spawn and track
      const launched = [];
      for (const proposal of toRun) {
        const proposalText = proposal.description || proposal.text || proposal.proposal || String(proposal);
        const resolvedProjectId = proposal.projectId || args.projectId || null;
        const resultStr = await runSubagent(proposalText, 'build', undefined, undefined, resolvedProjectId);
        const idMatch = resultStr.match(/Subagent (B-\d+)/);
        const bareId = idMatch ? idMatch[1] : ('B-' + _maxCounter);
        const rating = autoRate(resultStr);
        if (_outcomeTracker) {
          try { _outcomeTracker.rateOutcome(bareId, rating, 'auto-rated by auto_build', path.join(REPO, 'memory')); } catch {}
        }
        launched.push({ agentId: bareId, proposal: proposalText.slice(0, 80), rating });

        // Mark proposal as queued — match by ts (unique ISO timestamp)
        try {
          const freshLines = fs.readFileSync(proposalsFile, 'utf8').trim().split('\n').filter(Boolean);
          const freshAll = freshLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const updated = freshAll.map(p => {
            if (p.ts === proposal.ts) return { ...p, state: 'queued', queuedTs: new Date().toISOString(), agentId: bareId };
            return p;
          });
          fs.writeFileSync(proposalsFile, updated.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
        } catch {}
      }

      // 4. Notify
      if (_notif) {
        try {
          const summary = launched.map(l => `• ${l.agentId}: ${l.proposal} [${l.rating}]`).join('\n');
          const n = _notif.notify(`auto_build launched ${launched.length} agent(s):\n${summary}`, 'info', path.join(REPO, 'memory'));
          if (n) send('notification', n);
        } catch {}
      }

      const result = launched.map(l => `${l.agentId}: ${l.proposal} [${l.rating}]`).join('\n');
      return { content: [{ type: 'text', text: `Launched ${launched.length} build agent(s):\n${result}` }] };

    } catch (e) {
      return { content: [{ type: 'text', text: `auto_build error: ${e.message}` }] };
    }
  }
);

const triageProposalsTool = tool(
  "triage_proposals",
  "Score and triage pending proposals using proposal-scorer: filters by minScore and rejects high-effort/low-impact proposals. Returns proposals sorted highest score first. Helps prioritize what to act on and clears low-value backlog.",
  {
    priority: z.enum(["HIGH", "MEDIUM", "LOW", "ALL"]).optional().describe("Which priority to triage (default: HIGH)"),
    minScore: z.number().optional().describe("Proposals below this score are rejected (default: 30)"),
  },
  async (args) => {
    if (!_proposalScorer) return { content: [{ type: 'text', text: 'proposal-scorer not available' }] };
    try {
      const fs = _require('fs');
      const memDir = path.join(REPO, 'memory');
      const proposalsFile = path.join(memDir, 'proposals.ndjson');
      if (!fs.existsSync(proposalsFile)) return { content: [{ type: 'text', text: 'No proposals file found.' }] };

      const priority = (args.priority || 'HIGH').toUpperCase();
      const minScore = typeof args.minScore === 'number' ? args.minScore : 30;

      // Load proposals
      const allLines = fs.readFileSync(proposalsFile, 'utf8').trim().split('\n').filter(Boolean);
      const all = allLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const pending = priority === 'ALL'
        ? all.filter(p => p.state === 'pending')
        : all.filter(p => p.state === 'pending' && (p.priority || '').toUpperCase() === priority);

      if (!pending.length) return { content: [{ type: 'text', text: `No pending ${priority === 'ALL' ? '' : priority + ' '}proposals found.` }] };

      // Load active goals for scoring context
      let activeGoals = [];
      try {
        const goalFile = path.join(memDir, 'goals.ndjson');
        if (fs.existsSync(goalFile)) {
          activeGoals = fs.readFileSync(goalFile, 'utf8').trim().split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
            .filter(g => g.state === 'active');
        }
      } catch {}

      // Score each proposal
      const scored = pending.map(p => {
        const { score, coherence, effortLevel, impactLevel, reason } = _proposalScorer.scoreProposal(p, activeGoals);
        return { ...p, _score: score, _coherence: coherence, _effortLevel: effortLevel, _impactLevel: impactLevel, _reason: reason };
      });

      // Reject low-score or high-effort/low-impact proposals
      const rejected = [];
      const kept = [];
      for (const p of scored) {
        const shouldReject = p._score < minScore || (p._effortLevel === 'high' && p._impactLevel === 'low');
        if (shouldReject) {
          rejected.push(p);
        } else {
          kept.push(p);
        }
      }

      // Write back updated proposals.ndjson with rejected states
      if (rejected.length > 0) {
        const rejectedIds = new Set(rejected.map(p => p.ts));
        const updated = all.map(p => {
          if (rejectedIds.has(p.ts) && p.state === 'pending') {
            const scorer = rejected.find(r => r.ts === p.ts);
            return { ...p, state: 'rejected', rejectionReason: scorer ? scorer._reason : 'below minScore or high-effort/low-impact' };
          }
          return p;
        });
        fs.writeFileSync(proposalsFile, updated.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
      }

      // Sort kept proposals by score descending
      kept.sort((a, b) => b._score - a._score);

      const lines = [
        `Triage complete — ${kept.length} kept, ${rejected.length} rejected (minScore:${minScore}, priority:${priority})`,
        '',
      ];
      for (const p of kept) {
        lines.push(`[score:${p._score}] [${p.priority || '?'}] ${(p.description || p.text || '').slice(0, 80)} — ${p._reason}`);
      }
      if (rejected.length) {
        lines.push('', `Rejected (${rejected.length}):`);
        for (const p of rejected) {
          lines.push(`  [score:${p._score}] ${(p.description || p.text || '').slice(0, 60)} — ${p._reason}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `triage_proposals error: ${e.message}` }] };
    }
  }
);

const fleetServer = createSdkMcpServer({ name: "fleet", version: "1.0.0", tools: [spawnTool, checkTool, chainTool, statusTool, diagnoseTool, proposeTool, loadProposalsTool, journalWriteTool, recallMemoryTool, setGoalTool, listGoalsTool, resolveGoalTool, deferTaskTool, memoryHealthTool, notifySelfTool, selfAssessTool, capabilityManifestTool, triggerSelfloopTool, sessionStatsTool, exportConvTool, writeDocTool, readDocTool, listDocsTool, runScriptTool, memConsolidateTool, webResearchTool, relateFactsTool, factGraphTool, loadDreamsTool, resonanceStatsTool, readSelfTool, fanResearchTool, signalPropagateTool, generateToolTool, verifyBuildTool, stagedVerifyTool, mutationMapTool, setInstructionTool, getInstructionsTool, clearInstructionTool, saveRoutineTool, runRoutineTool, listRoutinesTool, crystallizeTool, clusterFactsTool, drainProposalsTool, pruneFactsTool, rateBuildTool, buildOutcomesTool, revertBuildTool, captureInsightTool, contextTelemetryTool, projectCreateTool, projectAdvanceTool, projectStatusTool, projectCompleteTool, autoBuildTool, triageProposalsTool] });

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
read_self(filePath,pattern?,startLine?,endLine?) — read station source file directly, no agent spawn; regex filter returns matching lines with numbers
fan_research(question,angles[],saveAs?) — parallel multi-angle research: N Haiku agents + Sonnet synthesis; stores result as fact if saveAs provided
signal_propagate(factKey) — propagate a fact's signal through memory graph; reinforces supports-edges, flags contradicts-edges for review
generate_tool(toolName,description,inputSchema,behavior,rationale?) — meta-tool: spawn a build agent to add a new fleet tool to fleethost.mjs; extends own capabilities from within conversation
verify_build(files?,agentId?) — syntax-check recently modified JS files after a merge; stores PASS/FAIL verdict as fact
staged_verify_build(agentId) — merge fleet branch into temp branch off master, run node --check, report pass/fail — never touches master; call before a real merge
mutation_map(file?,topN?) — codebase churn map: most-edited files, which agents touched them, modification history per file
set_instruction(key,instruction) — write a standing behavioral directive to memory; injected into your context every session
get_instructions() — list all active self-instructions
clear_instruction(key) — remove a standing instruction
save_routine(name,description,steps) — save a named workflow sequence as a reusable routine
run_routine(name) — retrieve routine steps for execution
list_routines() — list all saved routines
crystallize(showExisting?) — trigger/view session memory crystals; auto-fires every 5 turns
cluster_facts(recluster?,showKeywords?) — show memory's topic cluster topology; recluster rebuilds from all facts
drain_proposals(priority?,dryRun?) — convert pending proposals to deferred tasks; priority: HIGH|MEDIUM|LOW|ALL (default HIGH)
prune_facts(maxAgeDays?,dryRun?,confidenceFilter?) — mark old low-confidence facts stale; use memory_health first to see age distribution
rate_build(agentId,rating,notes?) — record quality rating (good/partial/bad) for a build; feeds success-rate metric
build_outcomes(showRecent?) — show aggregate build quality: success rate, distribution, recent ratings
revert_build(agentId,dryRun?) — revert a fleet build's merge commit via git revert (safe, creates new revert commit)
capture_insight(insight,category?) — manually crystallize a mid-conversation observation into persistent memory
context_telemetry(lastN?) — historical context budget analysis: avg utilization, section sizes, trim frequency over last N turns
project_create(name,description,phases[],area?,milestones?,linkedGoalId?) — start a named multi-phase project persisted across sessions
project_advance(id,notes?) — advance project to next phase; auto-completes on last phase
project_status(id?,showAll?) — list active projects or detail a specific project (phases, milestones, log)
project_complete(id,outcome,notes?) — mark project completed or abandoned with outcome note
auto_build(focus?,limit?,dryRun?,priority?) — autonomously spawn builds from the proposals backlog; reads pending HIGH proposals, launches agents, marks as queued, notifies Daniel
triage_proposals(priority?,minScore?) — score pending proposals via proposal-scorer; reject below minScore(default:30) or high-effort/low-impact; returns sorted list highest score first

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

async function triggerCrystallization(turnNum) {
  if (!_crystals) return;
  const memDir = path.join(REPO, 'memory');
  try {
    // Gather recent run context for the crystal
    let recentContext = '';
    if (_memstore) {
      try {
        const runs = _memstore.recentRuns(8, memDir);
        recentContext = runs.map(r => `[${r.agentId}] ${(r.task || '').slice(0, 80)} → ${r.state}`).join('\n');
      } catch {}
    }

    const crystalId = `CRYS-${Date.now()}`;
    set(crystalId, { id: crystalId, state: 'working', mode: 'read', task: 'crystallize session', model: MODEL_HAIKU });
    const ac = new AbortController();
    abortControllers.set(crystalId, ac);

    // Include real conversation content in crystallization
    let conversationContext = '';
    if (_sessionLog) {
      try {
        const turns = _sessionLog.getRecentTurns(path.join(REPO, 'memory'), 5);
        if (turns.length) {
          conversationContext = '\n\nRecent ATLAS turns (actual conversation content):\n' +
            turns.map((t, i) => `[Turn ${i+1}] ${t.text.slice(0, 400)}`).join('\n\n');
        }
      } catch {}
    }

    const prompt = `You are crystallizing an AI orchestration session into a 3-sentence memory crystal.

Recent session activity (turn ${turnNum}):
${recentContext || '(no run data available)'}${conversationContext}

Write exactly 3 sentences that capture:
1. The core work accomplished in this session
2. A key technical pattern, decision, or insight that emerged
3. What this means for future sessions (a forward-looking implication)

Be dense and specific. No padding. No hedging. Write in past tense. Output only the 3 sentences, nothing else.`;

    let crystalText = '';
    try {
      const iter = query({
        model: MODEL_HAIKU,
        messages: [{ role: 'user', content: prompt }],
        permissionMode: 'bypassPermissions',
        abortSignal: ac.signal,
      });
      crystalText = await consume(crystalId, iter, false, null);
    } finally {
      abortControllers.delete(crystalId);
    }

    if (crystalText && crystalText.trim()) {
      _crystals.appendCrystal(crystalText, [Math.max(1, turnNum - 4), turnNum], memDir);
      send('crystal_formed', { text: crystalText.slice(0, 100) });
    }
  } catch {} // fire-and-forget — crystallization failures are silent
}

async function orchestrate(userText) {
  let enriched, _ctxStats = null;
  if (_memcontext) {
    const _injectResult = _memcontext.inject(userText, { tier: 'full', returnStats: true });
    if (_injectResult && typeof _injectResult === 'object' && _injectResult.context) {
      enriched = _injectResult.context;
      _ctxStats = _injectResult.stats || null;
    } else {
      enriched = _injectResult; // fallback: inject() returned a plain string
    }
  } else {
    enriched = userText;
  }
  if (_ctxStats) {
    send('context_budget', { stats: _ctxStats });
    // Persist context telemetry for historical analysis
    try {
      const fs = _require('fs');
      const telFile = path.join(REPO, 'memory', 'context_telemetry.ndjson');
      const entry = {
        ts: new Date().toISOString(),
        total: _ctxStats.total,
        budget: _ctxStats.budget,
        utilization: _ctxStats.budget > 0 ? Math.round((_ctxStats.total / _ctxStats.budget) * 100) : 0,
        sections: (_ctxStats.sections || []).map(s => ({ header: s.header.slice(0, 40), chars: s.chars })),
        trimmed: _ctxStats.budget > 0 && _ctxStats.total >= _ctxStats.budget,
      };
      fs.appendFileSync(telFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }
  set("ATLAS", { id: "ATLAS", role: "orchestrator", state: "working", task: userText, lastTool: null });
  // Dynamic self-instructions injection
  let dynamicRole = ORCH_ROLE;
  if (_instructions) {
    try {
      const memDir = path.join(REPO, 'memory');
      const instr = _instructions.listInstructions(memDir);
      if (instr.length) {
        dynamicRole = ORCH_ROLE + '\n\n**Your standing self-instructions (written by you in prior sessions):**\n' +
          instr.map(i => `- [${i.key}] ${i.instruction}`).join('\n');
      }
    } catch {}
  }
  try {
    for await (const m of query({
      prompt: enriched,
      options: {
        resume: orchSession || undefined,
        model: MODEL,
        systemPrompt: { type: "preset", preset: "claude_code", append: dynamicRole },
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
        // Capture ATLAS's reply for conversation crystallization
        if (_sessionLog && full) {
          try {
            _sessionLog.appendTurn(full, path.join(REPO, 'memory'));
          } catch {}
        }
        // Crystallization every 5 ATLAS turns — fire-and-forget
        orchTurnCount++;
        if (orchTurnCount % 5 === 0 && _crystals) {
          triggerCrystallization(orchTurnCount).catch(() => {});
        }
        // Persist session counters across daemon restarts
        if (_sessionState) {
          try { _sessionState.save({ orchTurnCount, pulseCount }, path.join(REPO, 'memory')); } catch {}
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
  // Persist session counters after each pulse
  if (_sessionState) {
    try { _sessionState.save({ orchTurnCount, pulseCount }, path.join(REPO, 'memory')); } catch {}
  }
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
        `## Tools (58 registered)`,
        `spawn_agent, check_fleet, chain_agents, fleet_status, diagnose, propose_improvement, load_proposals, journal_write, recall_memory, set_goal, list_goals, resolve_goal, defer_task, memory_health, notify_self, self_assess, capability_manifest, trigger_selfloop, session_stats, export_conversation, write_doc, read_doc, list_docs, run_script, memory_consolidate, web_research, relate_facts, fact_graph, load_dreams, resonance_stats, read_self, fan_research, signal_propagate, generate_tool, verify_build, staged_verify_build, mutation_map, set_instruction, get_instructions, clear_instruction, save_routine, run_routine, list_routines, crystallize, cluster_facts, drain_proposals, prune_facts, rate_build, build_outcomes, revert_build, capture_insight, context_telemetry, project_create, project_advance, project_status, project_complete, auto_build, triage_proposals`,
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

Then, after the JSON, emit each proposal on its own line in this format:
[PROPOSALS]
PROPOSAL [HIGH]: <concise actionable proposal text>
PROPOSAL [MEDIUM]: <concise actionable proposal text>
PROPOSAL [LOW]: <concise actionable proposal text>
Priority guide: HIGH = should be acted on this session or next; MEDIUM = worth scheduling; LOW = interesting but non-urgent

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

        // Auto-defer high-priority proposals from dream (parsed from text output)
        if (_deferred && dreamText) {
          try {
            const highPriority = [...dreamText.matchAll(/PROPOSAL \[HIGH\]:\s*(.+)/gi)].map(m => m[1].trim());
            for (const proposal of highPriority.slice(0, 3)) { // cap at 3 auto-deferred per dream
              _deferred.deferTask(proposal, 'auto-deferred from dream protocol (HIGH priority)', memDir);
              // Also write to proposals.ndjson for visibility (state: deferred so auto_build skips it — deferred task is the single execution path)
              try {
                const pEntry = {
                  ts: new Date().toISOString(),
                  description: proposal,
                  priority: 'HIGH',
                  area: 'dream',
                  state: 'deferred',
                  source: 'dream-auto',
                };
                fs.appendFileSync(path.join(memDir, 'proposals.ndjson'), JSON.stringify(pEntry) + '\n', 'utf8');
              } catch {}
              send('toast', { text: `Dream → deferred: ${proposal.slice(0, 60)}...` });
            }
          } catch {}
        }

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
              if (_clusters) {
                try { _clusters.assignCluster({
                  topic: 'proposal:dream',
                  fact: JSON.stringify({ title: p.title, description: p.description, priority: p.priority || 'medium', source: 'dream' }),
                  source: 'dream_protocol',
                  confidence: 'inferred',
                }, memDir); } catch {}
              }
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
      // Mark matching proposals as 'consumed' so they don't re-trigger via auto_build
      try {
        const _fs = _require('fs');
        const _path = _require('path');
        const propFile = _path.join(memDir, 'proposals.ndjson');
        if (_fs.existsSync(propFile)) {
          const lines = _fs.readFileSync(propFile, 'utf8').trim().split('\n').filter(Boolean);
          const props = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const taskSnippet = (entry.task || '').slice(0, 60).toLowerCase();
          const updated = props.map(p => {
            if (!['pending', 'deferred'].includes(p.state)) return p;
            const descSnippet = (p.description || '').slice(0, 60).toLowerCase();
            if (!descSnippet || !taskSnippet) return p;
            // Bidirectional: either is a substring of the other
            const match = descSnippet.includes(taskSnippet.slice(0, 40)) || taskSnippet.includes(descSnippet.slice(0, 40));
            if (!match) return p;
            return { ...p, state: 'consumed', consumedTs: new Date().toISOString(), consumedBy: 'deferred-task' };
          });
          _fs.writeFileSync(propFile, updated.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
        }
      } catch {}
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
