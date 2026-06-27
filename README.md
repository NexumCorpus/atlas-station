# ATLAS // station

A desktop **oversight surface for a fleet of autonomous Claude agents.** Each row
in the brood is a real agent running through the Claude Code harness via
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
— with its own task, tools, turn count, and cost. The window is the station you
dispatch from and watch, not a single chat cell.

## What it is

- **Electron desktop app.** A single window (`index.html`) rendered in the Claude
  Code harness aesthetic — monospace, the eye that burns brighter as the fleet
  works, the brood of agents listed live.
- **A fleet engine, not one agent.** A plain-Node sidecar (`fleethost.mjs`) runs
  N agents concurrently. Each agent is driven by the Agent SDK's `query()` with
  `systemPrompt: "claude_code"`, so every agent literally runs inside the Claude
  Code harness.
- **Real state, never a mock.** The UI only shows what the engine actually reads
  off each running agent: current tool, summary, turns, `state`
  (`working` / `done` / `failed` / `needs-you`), and real USD cost from the
  `result` message.

## Prerequisites

- **Node.js 24.** The fleet sidecar is launched with a system Node binary
  (default `C:\Program Files\nodejs\node.exe`), and the bundled `node-pty`
  prebuild targets the Node 24 ABI. Override the binary with `NODE_BIN` if your
  Node lives elsewhere.
- **The `claude` CLI, installed and logged in.** The Agent SDK drives the same
  harness the CLI ships. It must be on your machine and authenticated.
- **Subscription auth — no API key.** Authenticate the CLI with your Claude
  subscription (`claude` → `/login`). The sidecars pass **no** `apiKey`; `query()`
  inherits the environment and rides the CLI's logged-in session.
  > Do **not** set `ANTHROPIC_API_KEY`. If it's present in the environment the SDK
  > will use it and bill the metered API instead of your subscription.

## Running

```bash
npm install
npm start          # → electron .
```

The window opens, the Electron main process spawns the fleet sidecar, and the
brood sits empty until you dispatch. Type a task in the bottom bar (optionally set
a working directory in the `cwd` field) and press **Enter** — the agent joins the
brood and starts running immediately.

### Environment knobs

| Variable     | Used by         | Default                               | Purpose                                  |
|--------------|-----------------|---------------------------------------|------------------------------------------|
| `NODE_BIN`   | `main.cjs`      | `C:\Program Files\nodejs\node.exe`    | Node binary used to spawn the sidecar    |
| `ATLAS_CWD`  | `fleethost.mjs` | `E:\`                                 | Fallback cwd when a dispatch omits one   |
| `CLAUDE_BIN` | `ptyhost.cjs`   | `C:\Users\…\.local\bin\claude.exe`    | Path to the `claude` CLI (PTY host only) |

> Defaults are currently Windows paths. On other platforms, set `NODE_BIN` /
> `ATLAS_CWD` accordingly.

## Dispatch modes — read vs build

The station has two conceptual ways to put an agent to work. The distinction is
how much the agent is allowed to *touch*.

- **Read** — *inspection, safe by default.* The agent gets the read-only tool set
  (`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `TodoWrite`, `Task`,
  `NotebookRead`). Anything that writes or executes is denied. The agent runs
  fully autonomously with nothing to approve, because nothing it does is
  destructive. This is what makes a large fleet safe to fan out at once.

- **Build** — *an isolated git worktree per agent, full tool access.* The agent is
  given its own **git worktree as its cwd**, so concurrent builders never collide
  in the same tree, and the full tool set — including write and exec — so it can
  actually make changes. Mutating actions route through a human-approval
  round-trip (the agent surfaces as `needs-you`; you approve or deny) before they
  land.

**Current status (MVP).** The shipped engine wires **read mode**: `fleethost.mjs`
auto-allows the `SAFE` tool set and denies write/exec with *"fleet MVP: read-only
until the approval panel."* Build mode is the designed next step — the dispatch
path already carries a per-agent `cwd`, and the approval round-trip
(`m.t === "decision"`) is stubbed for when the UI is wired. Until then the
read-only gate holds, by design.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Electron main  (main.cjs)                                     │
│  • creates the BrowserWindow, owns the lifecycle               │
│  • spawns the fleet sidecar, relays its messages → renderer    │
│  • receives "dispatch" from the renderer → sends to sidecar    │
└───────────────┬───────────────────────────┬──────────────────┘
        IPC (process)                 IPC (preload bridge)
                │                             │
   ┌────────────▼────────────┐   ┌────────────▼─────────────────┐
   │ Fleet engine            │   │ Harness renderer (index.html)│
   │ (fleethost.mjs)         │   │ • the brood, the eye, the bar│
   │ • plain Node + Agent SDK│   │ • window.atlas.dispatch(...) │
   │ • runs N agents via     │   │ • window.atlas.onFleet(cb)   │
   │   query({...})          │   │   renders live agent state   │
   │ • emits real per-agent  │   └──────────────────────────────┘
   │   state per message     │
   └─────────────────────────┘
```

- **Electron main (`main.cjs`)** — the conductor. Creates the window, spawns
  `fleethost.mjs` as a child process with an `ipc` channel, forwards every sidecar
  message to the renderer as a `"fleet"` event, and turns renderer `"dispatch"`
  requests into `{ t: "dispatch", id, task, cwd }` messages (assigning each agent
  an `A-<n>` id).

- **Fleet sidecar (`fleethost.mjs`)** — plain Node, **not** Electron, so the Agent
  SDK runs in a clean process. For each dispatch it calls `query()` and streams
  the result: `system/init` → captures the session id; `assistant` → bumps turns,
  records the last tool and a short summary; `result` → final `state` + cost. Each
  patch is pushed to the parent over IPC as an `agent` message.

- **Harness renderer (`index.html`)** — the oversight UI. Pure HTML/CSS/JS, no
  framework. Keeps a `Map` of agents keyed by id, re-renders the brood on every
  update, and drives the aggregate "eye" toward the fleet's overall condition
  (needs-you → working → settled). Talks to main only through the preload bridge.

- **IPC (`preload.cjs`)** — the only channel between renderer and main, exposed
  under `contextIsolation`. `window.atlas.dispatch(task, cwd)` sends work down;
  `window.atlas.onFleet(cb)` receives live fleet state up. No Node access leaks
  into the page.

## Source layout

| File            | Role                                                                          |
|-----------------|-------------------------------------------------------------------------------|
| `main.cjs`      | Electron main process — window, sidecar lifecycle, dispatch relay             |
| `fleethost.mjs` | Fleet engine sidecar — plain Node + Agent SDK, runs N agents, emits state     |
| `index.html`    | Harness renderer — the brood, the eye, the dispatch bar                       |
| `preload.cjs`   | Context-isolated IPC bridge (`window.atlas`)                                  |
| `ptyhost.cjs`   | Standalone PTY host — runs the real `claude` CLI in a pseudo-terminal (not wired into the fleet path) |
| `package.json`  | `electron .` start script + dependencies                                      |
```
