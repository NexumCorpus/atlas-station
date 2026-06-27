# ATLAS // station — Architecture

ATLAS is an Electron desktop harness for *overseeing a fleet* of autonomous
Claude agents — an oversight surface ("the station") showing many agents run
live, not a single chat.

**Electron main (`main.cjs`)** — Owns the `BrowserWindow` and app lifecycle. On
window load it spawns the fleet sidecar as a child *Node* process (`NODE_BIN`,
not Electron's runtime) over a Node `ipc` channel, relays every sidecar message
to the renderer (`webContents.send("fleet", …)`), and forwards renderer dispatch
requests down to the sidecar, tagging each with an `A-<n>` id.

**Fleet sidecar (`fleethost.mjs`)** — Plain-Node ESM process running agents via
`@anthropic-ai/claude-agent-sdk`'s `query()`. Each dispatch is one autonomous
agent on its own task + `cwd` (worktree); it streams SDK messages into a
per-agent state record (session, turns, last tool, summary, cost, state) and
pushes updates to main with `process.send`. Tool use is gated by `canUseTool`:
*read mode* (live) auto-allows a safe read-only set so agents never hang, while
*build mode* (write/exec) is denied pending a human-approval round-trip — the
"opened egg," not yet wired.

**IPC bridge (`preload.cjs`)** — A `contextIsolation` preload exposing a minimal
`window.atlas`: `dispatch(task, cwd)` and `onFleet(cb)`. With `nodeIntegration`
off, it is the renderer's only path to main.

**Harness renderer (`index.html`)** — The single-window UI ("the brood" + "the
eye"). It subscribes via `onFleet`, keeps an agents map, renders one row per
agent (id, task, last tool, state, cost) plus aggregate counts, and animates an
SVG eye whose color tracks the fleet's condition (needs-you/working/settled).
The dispatch bar sends task + cwd back through the bridge.

A sibling PTY sidecar (`ptyhost.cjs`) runs the real `claude` CLI in a
pseudo-terminal via node-pty, bridged over the same IPC pattern.
