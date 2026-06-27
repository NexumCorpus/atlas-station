// ATLAS // station — Electron main process.
// Runs the REAL Claude Code agent via @anthropic-ai/claude-agent-sdk (same
// engine, tools, agent loop as the CLI) on your subscription auth, and streams
// its messages to the harness window. One conversation, resumed per turn.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

let win = null;
let sessionId = null;       // resume the same Claude session across turns
let running = false;
let queryFn = null;

// MVP guardrail: auto-allow READ-ONLY tools so nothing hangs and nothing
// dangerous runs without a human in the loop. Write/exec land with the
// approval panel (next step). The agent gets a clean deny + keeps going.
const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite",
  "Task", "NotebookRead",
]);

async function getQuery() {
  if (!queryFn) ({ query: queryFn } = await import("@anthropic-ai/claude-agent-sdk"));
  return queryFn;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 780, backgroundColor: "#0a0908",
    title: "ATLAS // station",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  try { win.removeMenu(); } catch (_) {}
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function serialize(m) {
  // hand the renderer only plain data (no functions/cycles)
  if (m.type === "assistant") {
    const blocks = (m.message && m.message.content ? m.message.content : []).map((b) =>
      b.type === "text" ? { type: "text", text: b.text }
        : b.type === "tool_use" ? { type: "tool_use", name: b.name, input: b.input }
          : b.type === "thinking" ? { type: "thinking" }
            : { type: b.type });
    return { type: "assistant", blocks };
  }
  if (m.type === "result") return { type: "result", subtype: m.subtype, cost: m.total_cost_usd ?? null };
  if (m.type === "system") return { type: "system", subtype: m.subtype };
  return { type: m.type };
}

ipcMain.on("user-message", async (_e, text) => {
  if (running || !text || !text.trim()) return;
  running = true;
  if (win) win.webContents.send("agent-busy", true);
  try {
    const query = await getQuery();
    const options = {
      systemPrompt: "claude_code",
      canUseTool: async (name) => SAFE_TOOLS.has(name)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "station MVP is read-only for now — write/exec tools arrive with the approval panel." },
    };
    if (sessionId) options.resume = sessionId;
    for await (const m of query({ prompt: text, options })) {
      if (m.type === "system" && m.subtype === "init" && m.session_id) sessionId = m.session_id;
      if (win) win.webContents.send("agent-message", serialize(m));
    }
  } catch (e) {
    if (win) win.webContents.send("agent-message", { type: "error", text: String((e && e.message) || e) });
  } finally {
    running = false;
    if (win) win.webContents.send("agent-busy", false);
  }
});
