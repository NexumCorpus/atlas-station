// Bridge: dispatch agents into the fleet, receive live fleet state.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  dispatch: (task, cwd) => ipcRenderer.send("dispatch", { task, cwd }),
  onFleet: (cb) => ipcRenderer.on("fleet", (_e, m) => cb(m)),
});
