// Safe bridge between the harness window and the agent in the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  send: (text) => ipcRenderer.send("user-message", text),
  onMessage: (cb) => ipcRenderer.on("agent-message", (_e, m) => cb(m)),
  onBusy: (cb) => ipcRenderer.on("agent-busy", (_e, b) => cb(b)),
});
