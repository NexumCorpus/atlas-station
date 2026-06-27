// ATLAS // station — Electron main (FLEET). Spawns the fleet engine sidecar
// (fleethost.mjs, plain Node + Agent SDK), relays live per-agent state to the
// harness renderer, and dispatches new agents on request. The window is the
// oversight surface for many agents — the station, not a single cell.
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const NODE = process.env.NODE_BIN || "C:\\Program Files\\nodejs\\node.exe";
let win = null, fleet = null, counter = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 860, backgroundColor: "#0a0908", title: "ATLAS // station",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  try { win.removeMenu(); } catch (_) {}
  win.loadFile("index.html");
  win.webContents.on("did-finish-load", startFleet);
  win.on("closed", () => { stopFleet(); win = null; });
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
  fleet.on("message", (m) => { if (win && m) win.webContents.send("fleet", m); });
  if (fleet.stderr) fleet.stderr.on("data", () => {});
  fleet.on("exit", () => { fleet = null; });
}

function stopFleet() { try { if (fleet) fleet.kill(); } catch (_) {} fleet = null; }

ipcMain.on("dispatch", (_e, p) => {
  if (!fleet || !p || !p.task) return;
  counter++;
  const id = (p.mode === "build" ? "B-" : "A-") + counter;
  try { fleet.send({ t: "dispatch", id, task: p.task, cwd: p.cwd, mode: p.mode }); } catch (_) {}
});

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
