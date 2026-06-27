// Bridge: dispatch agents into the fleet, receive live fleet state.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  dispatch: (task, cwd, mode) => ipcRenderer.send("dispatch", { task, cwd, mode }),
  selfBuild: () => ipcRenderer.send("self-build"),
  onFleet: (cb) => ipcRenderer.on("fleet", (_e, m) => cb(m)),
});
