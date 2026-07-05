// ATLAS // station — Electron main (FLEET). Spawns the fleet engine sidecar
// (fleethost.mjs, plain Node + Agent SDK), relays live per-agent state to the
// harness renderer, and dispatches new agents on request. The window is the
// oversight surface for many agents — the station, not a single cell.
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");

const fs = require("fs");
const NODE = process.env.NODE_BIN || "C:\\Program Files\\nodejs\\node.exe";
let win = null, fleet = null, counter = 0;
let lastHistory = null; const lastAgents = new Map(); let reloadTimer = null;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.round(sw * 0.85), height: Math.round(sh * 0.88),
    minWidth: 960, minHeight: 620,
    backgroundColor: "#0a0908", title: "ATLAS // station",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  try { win.removeMenu(); } catch (_) {}
  win.loadFile("index.html");
  win.webContents.on("did-finish-load", () => {
    startFleet();
    // hot-reload state restore: re-push cached fleet state so a reload repopulates the UI
    if (win) {
      for (const a of lastAgents.values()) win.webContents.send("fleet", a);
      if (lastHistory) win.webContents.send("fleet", lastHistory);
    }
  });
  win.on("closed", () => { stopFleet(); win = null; });
  watchIndexForReload();
}

// Auto-reload the renderer whenever index.html changes on disk, so ATLAS's GUI
// edits appear instantly (no manual Ctrl+R). The fleet sidecar keeps running.
// Watch the specific file rather than the whole directory to reduce callback overhead.
function watchIndexForReload() {
  try {
    fs.watch(path.join(__dirname, "index.html"), { persistent: false }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) { try { win.webContents.reloadIgnoringCache(); } catch (_) {} }
      }, 200);
    });
  } catch (_) {}
}

function startFleet() {
  if (fleet) return;
  try {
    fleet = spawn(NODE, [path.join(__dirname, "fleethost.mjs")], {
      cwd: __dirname, env: process.env, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
  } catch (e) {
    if (win) win.webContents.send("fleet", { type: "error", m: String((e && e.message) || e) });
    return;
  }
  fleet.on("message", (m) => {
    if (!m) return;
    if (win) win.webContents.send("fleet", m);
    if (m.type === "agent" && m.id) lastAgents.set(m.id, m);
    else if (m.type === "history") lastHistory = m;
    else if (m.type === "counter" && typeof m.value === "number") counter = Math.max(counter, m.value);
  });
  if (fleet.stderr) fleet.stderr.on("data", () => {});
  fleet.on("exit", (code) => {
    fleet = null;
    if (win) {
      win.webContents.send("fleet", { type: "error", m: "fleet engine exited (code " + (code ?? "?") + ")" });
      if (code !== 0 && code !== null) setTimeout(startFleet, 2000);
    }
  });
}

function stopFleet() { try { if (fleet) fleet.kill(); } catch (_) {} fleet = null; }

ipcMain.on("dispatch", (_e, p) => {
  if (!fleet || !p || !p.task) return;
  counter++;
  const id = (p.mode === "build" ? "B-" : "A-") + counter;
  try { fleet.send({ t: "dispatch", id, task: p.task, cwd: p.cwd, mode: p.mode }); } catch (_) {}
});

ipcMain.on("reply", (_e, p) => {
  if (!fleet || !p || !p.id || !p.text) return;
  try { fleet.send({ t: "reply", id: p.id, text: p.text }); } catch (_) {}
});

ipcMain.on("say", (_e, p) => {
  if (!fleet || !p || !p.text) return;
  try { fleet.send({ t: "say", text: p.text }); } catch (_) {}
});

ipcMain.on("cancel", (_e, p) => {
  if (!fleet || !p || !p.id) return;
  try { fleet.send({ t: "cancel", id: p.id }); } catch (_) {}
});

ipcMain.on("read-memory", async (_e) => {
  try {
    const file = path.join(__dirname, "memory", "facts.ndjson");
    let data;
    try { data = await fs.promises.readFile(file, "utf8"); } catch { if (win) win.webContents.send("fleet", { type: "memory_facts", facts: [] }); return; }
    const lines = data.trim().split("\n").filter(Boolean);
    const facts = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); // newest first
    if (win) win.webContents.send("fleet", { type: "memory_facts", facts: facts.slice(0, 100) });
  } catch (e) {
    if (win) win.webContents.send("fleet", { type: "memory_facts", facts: [], error: String(e.message) });
  }
});

ipcMain.on("read-graph", async () => {
  try {
    const memDir = path.join(__dirname, "memory");
    async function tryRead(file) { try { return await fs.promises.readFile(file, "utf8"); } catch { return ""; } }
    // Read facts
    let facts = [];
    const factsData = await tryRead(path.join(memDir, "facts.jsonl"));
    if (factsData) {
      facts = factsData.trim().split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .slice(-80); // last 80 facts
    }
    // Read graph edges
    let edges = [];
    const graphData = await tryRead(path.join(memDir, "fact_graph.ndjson"));
    if (graphData) {
      edges = graphData.trim().split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    // Read stale keys
    let staleKeys = [];
    const staleData = await tryRead(path.join(memDir, "stale_facts.ndjson"));
    if (staleData) {
      staleKeys = staleData.trim().split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map(s => s.key);
    }
    if (win) win.webContents.send("fleet", { type: "graph_data", facts, edges, staleKeys });
  } catch (e) {
    if (win) win.webContents.send("fleet", { type: "graph_data", facts: [], edges: [], staleKeys: [], error: String(e.message) });
  }
});

ipcMain.on("export-conversation", (_e, p) => {
  try {
    const convDir = path.join(__dirname, "memory", "conversations");
    if (!fs.existsSync(convDir)) fs.mkdirSync(convDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = (p && p.title) ? p.title.replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 40) : 'conversation';
    const filename = `${ts}-${title.replace(/\s+/g, '-')}.md`;
    const content = p && p.content ? p.content : '';
    fs.writeFileSync(path.join(convDir, filename), content, 'utf8');
    if (win) win.webContents.send("fleet", { type: "conv_exported", filename, path: path.join(convDir, filename) });
  } catch (e) {
    if (win) win.webContents.send("fleet", { type: "error", m: "export failed: " + e.message });
  }
});

ipcMain.on("read-runs", async (_e) => {
  try {
    const file = path.join(__dirname, "memory", "runs.jsonl");
    let data;
    try { data = await fs.promises.readFile(file, "utf8"); } catch { if (win) win.webContents.send("fleet", { type: "runs_data", runs: [] }); return; }
    const lines = data.trim().split("\n").filter(Boolean);
    const runs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (win) win.webContents.send("fleet", { type: "runs_data", runs: runs.slice(-200) }); // last 200 runs
  } catch (e) {
    if (win) win.webContents.send("fleet", { type: "runs_data", runs: [] });
  }
});

ipcMain.on("list-docs", async (_e) => {
  try {
    const docsDir = path.join(__dirname, "docs");
    let files;
    try { files = await fs.promises.readdir(docsDir); } catch { if (win) win.webContents.send("fleet", { type: "docs_list", files: [] }); return; }
    if (win) win.webContents.send("fleet", { type: "docs_list", files: files.filter(f => !f.startsWith('.')) });
  } catch (e) { if (win) win.webContents.send("fleet", { type: "docs_list", files: [] }); }
});

ipcMain.on("read-doc", async (_e, filename) => {
  const cleaned = (filename || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  try {
    const filepath = path.join(__dirname, "docs", cleaned);
    let raw;
    try { raw = await fs.promises.readFile(filepath, 'utf8'); } catch { if (win) win.webContents.send("fleet", { type: "doc_content", filename: cleaned, content: '(not found)' }); return; }
    if (win) win.webContents.send("fleet", { type: "doc_content", filename: cleaned, content: raw.slice(0, 8000) });
  } catch (e) { if (win) win.webContents.send("fleet", { type: "doc_content", filename: filename || '', content: `Error: ${e.message}` }); }
});

ipcMain.handle("atlas:station-health", async () => {
  const memDir = path.join(__dirname, "memory");
  async function readNdjson(file) {
    try {
      const data = await fs.promises.readFile(file, "utf8");
      return data.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // Goals: active (not completed)
  const allGoals = await readNdjson(path.join(memDir, "goals.ndjson"));
  const goals = allGoals.filter(g => g.state !== "completed").map(g => ({ text: g.text, priority: g.priority, state: g.state }));

  // Proposals: pending or deferred
  const allProposals = await readNdjson(path.join(memDir, "proposals.ndjson"));
  const proposals = allProposals.filter(p => p.state === "pending" || p.state === "deferred").map(p => ({ title: p.title, priority: p.priority, _score: p._score }));

  // Outcomes: last 20
  const allOutcomes = await readNdjson(path.join(memDir, "outcomes.ndjson"));
  const last20 = allOutcomes.slice(-20);
  const goodCount = last20.filter(o => o.rating === "good").length;
  const outcomes = { total: last20.length, goodPct: last20.length ? Math.round(goodCount / last20.length * 100) : null };

  // Daemon: last daemon-start event from daemon-log.ndjson
  const allDaemon = await readNdjson(path.join(memDir, "daemon-log.ndjson"));
  const lastStart = allDaemon.filter(e => e.event === "daemon-start").slice(-1)[0] || null;
  let daemon;
  if (!lastStart) {
    daemon = { health: "NEVER-RUN", lastRunTs: null, hoursSinceRun: null };
  } else {
    const hrs = (Date.now() - new Date(lastStart.ts).getTime()) / 3600000;
    const health = hrs < 9 ? "HEALTHY" : hrs < 24 ? "DELAYED" : "STALE";
    daemon = { health, lastRunTs: lastStart.ts, hoursSinceRun: Math.round(hrs * 10) / 10 };
  }

  return { goals, proposals, outcomes, daemon };
});

// ── Estate engine — the station's own faculties, on screen (2026-07-05) ──────
// The STATION tab surfaces the compounding-lead vitals (moat + conversions), the
// recombination-wall map, and the wall-crossing engine. All shell out to
// station.py and degrade to an "ERR …" string; a slow station never blocks the
// GUI (Law III — nothing waits).
const STATION_PY = "E:/station/station.py";
function stationCall(verb, args) {
  return new Promise((res) => {
    execFile("python", [STATION_PY, verb, ...(args || [])],
      { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        res(out || (err ? "ERR " + ((stderr || "").trim() || err.message) : ""));
      });
  });
}
ipcMain.handle("atlas:estate", async () => ({
  moat: await stationCall("moat"),
  conversions: await stationCall("conversions"),
}));
ipcMain.handle("atlas:wall", async () => ({ wall: await stationCall("wall") }));
ipcMain.handle("atlas:discover", async () => ({ discover: await stationCall("discover") }));

// The orchestrator on itself: a preset batch of additive self-build tasks.
const SELF_BUILD = [
  "Read the source of this Electron app (main.cjs, fleethost.mjs, index.html) and write docs/OVERVIEW.md: a clear newcomer's tour of how a dispatched task becomes a running agent and returns to the brood. Then commit.",
  "Create CHANGELOG.md for atlas-station from the git log (run: git log --oneline), grouping the commits into a readable changelog that tells the story (single CLI embed -> fleet engine -> fleet UI -> build mode). Then commit.",
  "Review the repo for files that should be git-ignored but aren't (logs, worktree artifacts, scratch). Improve .gitignore ONLY (no other files). Then commit.",
];
ipcMain.on("self-build", () => {
  if (!fleet) return;
  for (const task of SELF_BUILD) { counter++; try { fleet.send({ t: "dispatch", id: "B-" + counter, task, mode: "build" }); } catch (_) {} }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { stopFleet(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
