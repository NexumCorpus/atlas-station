# ATLAS Station — Architecture Overview

## What Is This?

ATLAS Station is an Electron desktop application that wraps the Anthropic Claude Agent SDK into a multi-agent oversight console. The user talks to a single orchestrator called ATLAS; ATLAS delegates work to a managed fleet of subagents and reports back. The window is not a chat window for one AI — it is a station: a place from which many agents are launched, watched, and reviewed. Subagents doing read-only analysis and subagents making code changes in isolated git worktrees appear together in a live "brood" panel so nothing runs out of sight.

---

## The Three-Process Architecture

```
Electron main (main.cjs)
    │  spawns with stdio IPC
    ▼
Fleet sidecar (fleethost.mjs)  ← plain Node.js, not Electron
    │  sends "agent" events back up the IPC pipe
    ▼
Renderer (index.html)          ← receives events via preload bridge
```

**Electron main** (`main.cjs`) is deliberately thin. It creates the browser window, spawns the fleet sidecar as a child process with a Node IPC channel (`stdio: ["pipe","pipe","pipe","ipc"]`), and acts as a relay: IPC messages from the renderer arrive here and are forwarded to the sidecar; messages from the sidecar are forwarded to the renderer. Main holds no agent state and runs no SDK calls. If the sidecar crashes (non-zero exit), main restarts it after 2 seconds.

**The fleet sidecar** (`fleethost.mjs`) is a plain Node.js process — not Electron — by design. Native modules that depend on Node's ABI (and any future PTY work) break under Electron's patched runtime; separating the sidecar avoids the rebuild problem entirely. This is where all Claude Agent SDK calls happen: `query()` from `@anthropic-ai/claude-agent-sdk` drives both the ATLAS orchestrator conversation and every subagent it spawns.

**The renderer** (`index.html`) is a static HTML/CSS/JS page. It has no direct Node access; `preload.cjs` exposes a narrow `window.atlas` API through Electron's context bridge. The left column shows the conversation thread with ATLAS; the right column shows the brood — a live grid of subagent cards updated in real time as state events arrive from the sidecar.

---

## How a User Message Becomes a Running Agent

```
User types → atlas.say() → ipcRenderer.send("say") → ipcMain ("say") →
fleet.send({ t:"say", text }) → process.on("message") →
orchestrate(text) → query(ATLAS prompt + fleet MCP server) →
ATLAS calls spawn_agent tool → runSubagent(task, mode) →
  [build] makeWorktree(id) → isolated branch in E:\atlas-wt\
  query(enriched prompt, { cwd: worktree, permissionMode:"bypassPermissions" }) →
  consume() → set(id, patch) → send("agent", a) →
    IPC → main → win.webContents.send("fleet", a) →
      preload → onFleet callback → brood card updates live
```

Walking through the path step by step:

1. **say**: The user hits Enter in the input bar. `window.atlas.say(text)` calls `ipcRenderer.send("say", {text})` through the preload bridge.

2. **IPC relay**: `main.cjs` receives the `"say"` IPC event and forwards it over the Node IPC pipe to the sidecar: `fleet.send({ t:"say", text })`.

3. **orchestrate**: The sidecar's `process.on("message")` handler routes `t:"say"` to `orchestrate(userText)`. Before passing the text to the model, `memcontext.inject()` prepends the station's memory block (see below). Then a `query()` call is opened against the ATLAS system prompt. ATLAS has access to two tools hosted in a local MCP server (`fleetServer`): `spawn_agent` and `check_fleet`.

4. **spawn_agent → runSubagent**: When ATLAS decides work is needed, it calls `spawn_agent` with a complete task description and a mode (`"read"` or `"build"`). This invokes `runSubagent(task, mode)`.

5. **worktree** (build mode only): `makeWorktree(id)` runs `git worktree add -f -b fleet/<id> <dir> HEAD`, creating a fresh checkout on a new branch under `E:\atlas-wt\`. The subagent's `cwd` is set to this directory, not the live repo. The task prompt receives an appended `BUILD_NOTE` that tells the agent it is in an isolated worktree and must commit before finishing.

6. **query (subagent)**: `consume(id, query({prompt: enriched, options}), ...)` opens a second SDK stream. In read mode the agent's tools are gated to a safe set (Read, Glob, Grep, WebSearch, WebFetch). In build mode `permissionMode: "bypassPermissions"` grants the full tool surface.

7. **result → brood**: As the stream produces events, `consume()` calls `set(id, patch)` on each turn. `set` updates the in-memory `agents` Map, then calls `send("agent", a)` which sends the full agent record over the IPC pipe to main, which forwards it to `win.webContents.send("fleet", a)`, which the preload's `onFleet` callback delivers to the renderer's brood panel. Subagent cards animate between `working`, `done`, `failed`, and `interrupted` states in real time.

---

## Read Mode vs Build Mode

Every subagent runs in one of two modes, and the difference is both architectural and security-meaningful.

**Read mode** (`mode: "read"`) is for analysis, surveys, and questions. The subagent runs with its `cwd` set to the live repo (`E:\atlas-station`) but its tool use is restricted by a `canUseTool` gate that allows only: Read, Glob, Grep, WebSearch, WebFetch, TodoWrite, Task, and NotebookRead. Any attempt to use Bash, Edit, Write, or other mutating tools is denied with `"read-only"`. The subagent can look at everything but change nothing.

**Build mode** (`mode: "build"`) is for changes. A dedicated git worktree is created on its own branch (`fleet/<id>`), and the subagent runs there with `permissionMode: "bypassPermissions"` — the full Claude Code tool set, no approval prompts. The task prompt ends with `BUILD_NOTE`, which tells the agent its worktree is its universe: use relative paths, commit before finishing, do not push. After the agent completes, `branchStat()` records how many commits and how much diff it produced. The branch stays in git until a merge decision is made.

ATLAS itself is also constrained: its `canUseTool` gate allows the fleet MCP tools and the same safe read set, but denies everything else. To make any change to the repo, ATLAS must spawn a build subagent — it cannot touch the live tree directly.

---

## Persistence

Three modules handle durability across restarts.

**`persist.cjs` / `fleet-state.json`** is the primary state store. Every call to `set(id, patch)` — the function that updates an agent's record and fans out to the renderer — also calls `_persist.save()`, which serializes the full `agents` Map plus `maxCounter` and `orchSession` to disk. On startup, `_persist.load()` restores this state: agents that were `"working"` when the process last died are re-emitted to the renderer with state `"interrupted"` so they appear correctly in the brood. The counter and ATLAS's conversation session are also restored.

**`orchSession`** is the ATLAS conversation session ID. The SDK's `query()` returns a `session_id` in the `system/init` event; the sidecar captures it in `orchSession`. On the next user message, `orchestrate()` passes `resume: orchSession` to `query()`, resuming the same conversation thread. Session ID is saved through `persist.cjs` so it survives a full restart — Daniel can close the app and reopen it, and ATLAS continues where it left off.

**`memstore.cjs`** is an append-only run log. Each time a subagent completes (or fails), `_memstore.appendRun()` records the agent ID, task description, mode, final state, cost, and summary. On startup, `memstore.recentRuns(50)` fetches the last fifty entries, which are sent to the renderer alongside the git commit log so the ledger panel shows both code history and agent history in one timeline.

---

## Memory Injection

`memcontext.cjs` ensures that every agent — ATLAS itself, and every subagent it spawns — enters its task with the station's accumulated project knowledge already in context. The module is loaded once at sidecar startup and its `inject(task)` function is called before any `query()` invocation.

`inject()` reads MEMORY.md from Claude Code's project memory directory (`~/.claude/projects/E--atlas-station/memory/MEMORY.md`), truncates it to a configured character limit, pulls recent structured facts and run summaries from memstore, and prepends the result as a clearly delimited block:

```
--- ATLAS MEMORY ---
[journal excerpt]
[recent structured facts]
[recent run summaries]
--- END MEMORY ---

[original task]
```

The delimiter matters: agents can distinguish between memory that was delivered to them and the actual task they are being asked to perform.

The design principle is deliberate: memory is *delivered*, not *available*. An agent that could search for memory files might not find the right ones, or might not search at all. By injecting context at dispatch time, every agent starts informed regardless of its search behavior.

`inject()` is a pure enrichment: if the journal file is missing, if memstore is unavailable, or if any read fails, it returns the original task unchanged. Memory failure must never stall the fleet.
