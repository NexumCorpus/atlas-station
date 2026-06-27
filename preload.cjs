// Safe bridge between the xterm window and the PTY sidecar (via main).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  ptyInput: (d) => ipcRenderer.send("pty-input", d),
  ptyResize: (cols, rows) => ipcRenderer.send("pty-resize", { cols, rows }),
  ptyRestart: () => ipcRenderer.send("pty-restart"),
  onPtyData: (cb) => ipcRenderer.on("pty-data", (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on("pty-exit", (_e, c) => cb(c)),
});
