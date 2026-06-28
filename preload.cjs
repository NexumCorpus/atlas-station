// Bridge: dispatch agents, reply into an agent's conversation, receive fleet state.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  dispatch: (task, cwd, mode) => ipcRenderer.send("dispatch", { task, cwd, mode }),
  replyAgent: (id, text) => ipcRenderer.send("reply", { id, text }),
  selfBuild: () => ipcRenderer.send("self-build"),
  onFleet: (cb) => ipcRenderer.on("fleet", (_e, m) => cb(m)),
});
