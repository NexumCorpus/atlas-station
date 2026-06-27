// THE ORCHESTRATOR ON ITSELF. Dispatch a fan-out of build agents, each in its
// own isolated worktree, each building a distinct next-layer of atlas-station.
// Every task produces NEW files (clean merges). The overseer reviews the
// fleet/<id> branches and merges what's good.
import { spawn, execFileSync } from "child_process";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const REPO = "E:\\atlas-station";

const TASKS = [
  { id: "B-readme", task: "Create README.md for 'atlas-station' — an Electron desktop app that runs a FLEET of autonomous Claude agents (via @anthropic-ai/claude-agent-sdk) in the Claude Code harness aesthetic. Read the actual source (main.cjs, fleethost.mjs, index.html, package.json) so it's accurate. Document: what it is; prerequisites (Node 24, the claude CLI, subscription auth — NO API key); how to run (npm start); the read vs build dispatch modes (build = an isolated git worktree per agent with full tool access); and a short architecture overview (Electron main + plain-Node SDK sidecar + harness renderer + IPC). Clean and correct. Then commit." },
  { id: "B-tests", task: "Create tests/fleet.test.mjs — a self-contained Node test. Read ../fleethost.mjs first to match its IPC protocol EXACTLY (send {t:'dispatch',id,task,mode}; receive {type:'ready'} then {type:'agent',...} updates). The test spawns fleethost.mjs as a child with stdio ['pipe','pipe','pipe','ipc'], waits for ready, dispatches a read-mode agent on a trivial task (e.g. 'List the files here in one sentence.'), asserts it reaches state 'done' within a timeout, prints PASS, and exits 0 on success / 1 on failure. Include a comment on how to run it. Then commit." },
  { id: "B-persist", task: "Create persist.cjs — a CommonJS module to persist fleet state. Export save(state, filePath) and load(filePath): save writes JSON atomically (temp file then rename); load returns the parsed object or null if missing. Default the path to 'fleet-state.json' beside the module. Add an `if (require.main === module)` self-test that saves a sample state, loads it back, asserts deep equality, and prints PASS or FAIL with a non-zero exit on failure. Then commit." },
  { id: "B-packaging", task: "Create docs/PACKAGING.md — research and document packaging this Electron app as a distributable Windows .exe with electron-builder. Read package.json and main.cjs first. Include: the devDependency to add; the exact package.json 'build' config block (appId, productName, win nsis target, and CRITICALLY that the native sidecar @homebridge/node-pty-prebuilt-multiarch and the SDK must be unpacked from asar via asarUnpack); the build script; and the exact command. Be concrete and correct. Then commit." },
  { id: "B-approval", task: "Create docs/design/APPROVAL_ROUNDTRIP.md — a concrete implementation design for a human-in-the-loop approval round-trip, so build agents can request risky tools that the overseer approves in the UI (the 'opened egg'). Read fleethost.mjs, main.cjs, preload.cjs, index.html first. Specify precisely: how canUseTool returns a Promise that pends and emits {type:'approval',id,tool,input}; how main.cjs relays it to the renderer and routes the decision back; how the renderer surfaces it and calls a decide(id, allow) bridge; how fleethost matches the decision to the pending Promise and resolves allow/deny to resume the agent. Give the specific code changes per file. Then commit." },
  { id: "B-agentlog", task: "Create agentlog.cjs — a CommonJS module that logs a fleet agent's event stream. Export createLogger(agentId, dir) returning { event(obj), close() }; event() appends one JSON line (with the object) to `<dir>/<agentId>.jsonl`, creating dir if needed; close() flushes. Add an `if (require.main === module)` self-test that writes two events, reads the file back, asserts two parseable lines, and prints PASS or FAIL with a non-zero exit on failure. Then commit." },
];

const host = spawn(NODE, ["fleethost.mjs"], { stdio: ["pipe", "pipe", "pipe", "ipc"], env: process.env });
const state = {};

host.on("message", (m) => {
  if (m.type === "ready") {
    TASKS.forEach((t) => host.send({ t: "dispatch", id: t.id, task: t.task, mode: "build" }));
    console.log("dispatched " + TASKS.length + " build agents into isolated worktrees");
  } else if (m.type === "agent") {
    const prev = state[m.id]?.state;
    state[m.id] = m;
    if ((m.state === "done" || m.state === "failed") && prev !== m.state) {
      console.log(`[${m.id}] ${m.state}${m.commits != null ? " · " + m.commits + "c · " + (m.branchStat || "") : ""}${m.cost != null ? " · $" + Number(m.cost).toFixed(2) : ""}`);
    }
  }
});
if (host.stderr) host.stderr.on("data", (b) => process.stderr.write("[host] " + b));

const settled = () => {
  const v = Object.values(state);
  return v.length >= TASKS.length && v.every((a) => a.state === "done" || a.state === "failed");
};

const start = Date.now();
const iv = setInterval(() => {
  if (settled() || Date.now() - start > 12 * 60 * 1000) { clearInterval(iv); report(); }
}, 3000);

function report() {
  console.log("\n=== FAN-OUT COMPLETE ===");
  for (const t of TASKS) {
    const a = state[t.id] || {};
    let files = "";
    try { files = execFileSync("git", ["-C", REPO, "diff", "--name-only", "master..fleet/" + t.id], { encoding: "utf8" }).trim().replace(/\n/g, ", "); } catch (_) {}
    console.log(`${t.id}: ${a.state || "?"} | ${a.commits || 0} commits | ${a.branchStat || ""} | ${files}`);
  }
  const done = Object.values(state).filter((a) => a.state === "done").length;
  const cost = Object.values(state).reduce((s, a) => s + (a.cost || 0), 0);
  console.log(`\n${done}/${TASKS.length} delivered · ~$${cost.toFixed(2)} · branches fleet/<id> · review with: git diff master..fleet/<id>`);
  try { host.kill(); } catch (_) {}
  process.exit(0);
}
