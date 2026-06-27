// ATLAS // station — Electron main. Hosts the REAL claude CLI by spawning a
// plain-Node PTY sidecar (ptyhost.cjs) and bridging it to the xterm.js terminal
// in the window. Electron never loads node-pty itself (avoids the Electron-ABI
// rebuild); the sidecar runs under real Node 24 with the prebuilt PTY.
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const NODE = process.env.NODE_BIN || "C:\\Program Files\\nodejs\\node.exe";
let win = null;
let host = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 820, backgroundColor: "#0a0908",
    title: "ATLAS // station",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  try { win.removeMenu(); } catch (_) {}
  win.loadFile("index.html");
  win.webContents.on("did-finish-load", startHost);
  win.on("closed", () => { stopHost(); win = null; });
}

function startHost() {
  if (host) return;
  try {
    host = spawn(NODE, [path.join(__dirname, "ptyhost.cjs")], {
      cwd: __dirname, env: process.env,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
  } catch (e) {
    if (win) win.webContents.send("pty-data", "\r\n\x1b[31m[failed to start PTY host: " + (e && e.message ? e.message : e) + "]\x1b[0m\r\n");
    return;
  }
  host.on("message", (m) => {
    if (!win || !m) return;
    if (m.t === "d") win.webContents.send("pty-data", m.d);
    else if (m.t === "exit") win.webContents.send("pty-exit", m.code);
    else if (m.t === "fatal") win.webContents.send("pty-data", "\r\n\x1b[31m[" + m.m + "]\x1b[0m\r\n");
  });
  if (host.stderr) host.stderr.on("data", (b) => {
    if (win) win.webContents.send("pty-data", "\x1b[2m" + b.toString() + "\x1b[0m");
  });
  host.on("exit", () => { host = null; });
}

function stopHost() { try { if (host) host.kill(); } catch (_) {} host = null; }

ipcMain.on("pty-input", (_e, d) => { try { if (host) host.send({ t: "i", d }); } catch (_) {} });
ipcMain.on("pty-resize", (_e, s) => { try { if (host && s) host.send({ t: "r", cols: s.cols, rows: s.rows }); } catch (_) {} });
ipcMain.on("pty-restart", () => { stopHost(); startHost(); });

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { stopHost(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
