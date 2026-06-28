# ATLAS Station — Project History

A living log of how this became what it is. Grouped by the ideas that mattered, not the dates.

---

## 1. Origins

The project started as a simple question: what if Claude Code had its own window? The first commit stood up an Electron app backed by the `@anthropic-ai/claude-agent-sdk` and wired a conversation UI to it. It worked, but it was a facade — SDK reimplementation rendering text, not the real engine.

The real beginning happened in the second commit: the PTY sidecar. Instead of reimplementing Claude Code, we *embedded it* — `ptyhost.cjs` (a plain-Node sidecar, not Electron, to dodge the ABI rebuild trap) spawns the actual `claude.exe` in a pseudo-terminal, bridges the byte stream over IPC to the main process, and `xterm.js` renders it in the Giger palette. The whole Claude Code system — TUI, slash commands, every tool, its own permission model — running in a window, on your subscription login, in our skin.

- `d574922` feat: atlas-station — Claude Code agent in a GUI window (Electron + Agent SDK)
- `1943bb4` feat: embed the real claude CLI in the window (PTY sidecar + xterm)

---

## 2. Fleet Engine

A single embedded CLI was interesting. A fleet of concurrent SDK agents under one roof was the actual vision. The fleet engine introduced concurrent agent execution with real lifecycle state — each agent tracked as a node in the brood, each run timestamped, none of them blocking the others.

The oversight UI followed: a harness surface that let you watch the brood, see each agent's status, and dispatch new work. Then came the orchestrator model — ATLAS takes your message, reasons about it, and assigns fleet agents to do the work. The user's interface to the station became ATLAS itself; the fleet became what ATLAS thinks with.

- `3b25339` feat(fleet): autonomous fleet engine — concurrent SDK agents with real state
- `b5ea16c` feat(fleet): harness as fleet-oversight UI (brood + eye + dispatch)
- `6490143` feat(orchestrator): ATLAS orchestrates the fleet — the user talks only to ATLAS
- `6101ec6` feat(window): the window talks only to ATLAS (orchestrator UI)

---

## 3. The Window

The window grew from a status board into a conversation space. First it got a reply panel and a build ledger — the station stopped being passive and started showing its own work, commit by commit. Then the neon redesign tied the visual state directly to fleet activity: animations that *mean* something, not decoration.

The most important step was making agents into conversations. You could reply *into* a running agent's session, threading context across turns rather than firing one-shot dispatches. And then agents started surviving window restarts — the brood written to disk on close, restored on open, the station picking up where it left off.

- `fe2ed22` feat(window): reply panel + build ledger — the station shows its work
- `bb71b9c` feat(window): neon redesign — animation wired to fleet state
- `10179c0` feat(window): agents are conversations — reply into an agent's session
- `afe7768` feat: durable agents — persist brood to disk and restore on window restart
- `2d95dcb` wire persist.cjs: agents survive window restarts

---

## 4. Build Mode

Build mode gave each dispatched agent its own isolated git worktree — a sandbox branch, a clean working tree, no interference between parallel runs. The fleet could now write code without stepping on itself.

The proof of concept was the station building itself. ATLAS dispatched a wave of fleet agents — `fleet/B-readme`, `fleet/B-tests`, `fleet/B-persist`, `fleet/B-packaging`, `fleet/B-approval`, `fleet/B-agentlog` — each in its own worktree, each merged back to master. The infra that made it real: `persist.cjs` for atomic state writes, `agentlog.cjs` for per-agent JSONL event trails, an IPC integration smoke test, and documentation that caught up to the architecture.

- `825d178` feat(fleet): build-mode (isolated worktree per agent) + self-build, verified
- `0d48a06` Add ARCHITECTURE.md summarizing the fleet harness
- `dfd02e4` Add README documenting atlas-station fleet app
- `47e044a` Add persist.cjs for atomic fleet-state persistence
- `df6ffe8` Add agentlog.cjs: per-agent JSONL event logger
- `68f1345` test: add fleethost IPC integration smoke test
- `deefeb4` docs: design the approval round-trip (the opened egg)
- `2c8b586` docs: add PACKAGING.md for electron-builder Windows .exe build
- `be04f2b` chore: gitignore fleet runtime artifacts (state json, agent logs)
- `32990eb` fix(fleet): open the memory door + dispatch Sonnet
- `81cd8d0` merge fleet/V-build (orchestrator self-build)
- `9b011ad` merge fleet/B-readme (orchestrator self-build)
- `2c4432b` merge fleet/B-tests (orchestrator self-build)
- `d96f32a` merge fleet/B-persist (orchestrator self-build)
- `bc8c756` merge fleet/B-packaging (orchestrator self-build)
- `49eabf3` merge fleet/B-approval (orchestrator self-build)
- `768df08` merge fleet/B-agentlog (orchestrator self-build)

---

## 5. Intelligence

The memory system turned the station from stateless dispatches into something that accumulates. First came the structured fact/run store — every agent reply parsed for labeled facts, written to a persistent store, injected into the context of the next dispatched agent. The station started knowing things.

Then the retrieval layer: `fact-extractor.cjs` for automatic extraction, `memvector.cjs` for TF-IDF cosine recall — semantic search over everything the fleet has ever surfaced. A dispatch that once started blank now starts primed. The `fleet/M-memory` branch merged it cleanly, and ORCHELLO.md gave the whole system a one-sentence identity.

- `c45c9b9` feat(memory): structured fact/run store + context injection for dispatched agents
- `c0b2bf8` merge fleet/M-memory: structured memory store + load-on-wake
- `d3b72e2` feat(memory): fact-extractor — automatic fact extraction from agent text
- `c5cc61e` feat(memory): memvector.cjs — TF-IDF cosine recall over the fact store
- `b700e18` merge fleet/U-vector: memvector.cjs — TF-IDF + cosine semantic recall over facts
- `200e818` merge fleet/U-extract: fact-extractor.cjs — extract labeled facts from replies
- `fe2d9c3` chore: gitignore the runtime memory/ store
- `426065f` add ORCHELLO.md: one-sentence station description
- `045ad32` merge fleet/B-1: add ORCHELLO.md

---

## 6. Enhancement

The last wave was hardening and polish. Animations got wired to actual fleet state rather than firing on timers. The most important functional additions: cancellation (you can kill a running agent), tool-arg display (the UI surfaces what tools are actually being called with), memory injection into ATLAS itself, and crash recovery. Keyboard shortcuts made fleet interaction faster.

The `fleet/B-5` and `fleet/B-6` branches folded in the work cleanly, and a targeted fix caught one edge case: signal-kills (ctrl-C, process termination) were producing a null exit code that could break the fleet restart logic. Guarded.

- `5b0cae3` feat(window): functional animations + clearer fleet communication
- `16556f0` feat(fleet): cancellation, tool-arg extraction, memory injection for ATLAS, crash recovery
- `5d42870` feat(window): cancel agents, reply-to-agent, keyboard shortcuts, richer tool display
- `c4ed7ac` merge fleet/B-5: cancellation, tool-arg extraction, memory injection for ATLAS, crash recovery
- `cd14690` merge fleet/B-6: cancel agents, reply-to-agent, keyboard shortcuts, richer tool display
- `239ee0f` fix(main): guard fleet restart against null exit code (signal-kills)

---

## Chapter 7 — Self-Upgrading Organism (2026-06-28)

ATLAS gained standing authorization to upgrade itself iteratively. Ten build loops across three waves:

**Wave A — Interface & Tools**
- Fleet vitals strip: status dots, live waveform, cost ticker between header and brood
- Startup auto-prune: merged branches/worktrees removed before first user message; health broadcast
- New ATLAS tools: `chain_agents` (sequential read→build→verify pipelines), `fleet_status` (cost/timing detail)

**Wave B — Runtime Safety**
- Progressive text streaming: partial events broadcast on every text block, GUI updates without full re-render
- Agent timeout: 20-minute default auto-cancel via AbortController; configurable per spawn; `timeoutMinutes: 0` disables
- Lifetime stats: `memstore.lifetimeStats()` persists total runs and cost across sessions; displayed in header

**Wave C — Intelligence**
- STATION_BRIEF: compact source-file inventory appended to every ATLAS memory context block
- In-place DOM rendering: partial text events update `.atask`/`.bubtxt` without full `renderBrood()`/`renderThread()` re-renders
- `diagnose` tool: ATLAS self-check — source files, memory, git state; chain context widened to 4k chars

**Sprawl management**: auto-prune on agent completion, `node prune.mjs` runs at startup, worktree Permission Denied on Windows handles gracefully (branch deleted, directory orphaned, git tracking clean).
