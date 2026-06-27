// Plain-Node PTY host (sidecar). Runs the REAL `claude` CLI in a pseudo-
// terminal using the prebuilt node-pty (Node-24 ABI — never the broken winpty
// build, never an Electron-ABI rebuild), and bridges it to the Electron parent
// over the process IPC channel. This is why the whole system ports in: it IS
// the CLI, with a TTY, not a reimplementation.
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

const CLAUDE = process.env.CLAUDE_BIN || "C:\\Users\\dalea\\.local\\bin\\claude.exe";
const CWD = process.env.ATLAS_CWD || "E:\\";

let term = null;
try {
  term = pty.spawn(CLAUDE, [], {
    name: "xterm-256color",
    cols: 120, rows: 30,
    cwd: CWD,
    env: process.env,
  });
} catch (e) {
  if (process.send) process.send({ t: "fatal", m: "could not start claude: " + (e && e.message ? e.message : e) });
  process.exit(1);
}

term.onData((d) => { if (process.send) process.send({ t: "d", d }); });
term.onExit((ev) => {
  if (process.send) process.send({ t: "exit", code: (ev && ev.exitCode) || 0 });
  process.exit(0);
});

process.on("message", (m) => {
  if (!m || !term) return;
  if (m.t === "i") { try { term.write(m.d); } catch (_) {} }
  else if (m.t === "r") { try { term.resize(Math.max(2, m.cols | 0), Math.max(2, m.rows | 0)); } catch (_) {} }
});
process.on("disconnect", () => { try { term.kill(); } catch (_) {} process.exit(0); });
