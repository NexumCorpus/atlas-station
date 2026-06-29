// Bridge: dispatch agents, reply into an agent's conversation, receive fleet state.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  say: (text) => ipcRenderer.send("say", { text }),
  dispatch: (task, cwd, mode) => ipcRenderer.send("dispatch", { task, cwd, mode }),
  replyAgent: (id, text) => ipcRenderer.send("reply", { id, text }),
  selfBuild: () => ipcRenderer.send("self-build"),
  cancel: (id) => ipcRenderer.send("cancel", { id }),
  readMemory: () => ipcRenderer.send("read-memory"),
  readRuns: () => ipcRenderer.send("read-runs"),
  exportConversation: (p) => ipcRenderer.send("export-conversation", p),
  readDoc: (filename) => ipcRenderer.send("read-doc", filename),
  listDocs: () => ipcRenderer.send("list-docs"),
  readGraph: () => ipcRenderer.send("read-graph"),
  stationHealth: () => ipcRenderer.invoke("atlas:station-health"),
  onFleet: (cb) => ipcRenderer.on("fleet", (_e, m) => cb(m)),
});
