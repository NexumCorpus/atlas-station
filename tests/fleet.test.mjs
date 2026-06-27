// tests/fleet.test.mjs
//
// Integration smoke test for the fleet engine (../fleethost.mjs).
//
// ── HOW TO RUN ────────────────────────────────────────────────────────────
//   1. Install deps once (from the repo root):   npm install
//   2. Make sure Claude auth is available, one of:
//        • ANTHROPIC_API_KEY env var, or
//        • a logged-in Claude Code session (CLAUDE_CODE_OAUTH_TOKEN)
//   3. Run it:                                    node tests/fleet.test.mjs
//
//   Prints "PASS" and exits 0 on success; prints "FAIL: ..." and exits 1
//   otherwise. No test framework required — it's a self-contained script.
// ──────────────────────────────────────────────────────────────────────────
//
// What it does: spawns fleethost.mjs over an IPC channel the same way main.cjs
// does (stdio ['pipe','pipe','pipe','ipc']), waits for the host's {type:'ready'}
// handshake, dispatches ONE autonomous agent on a trivial read-only task, and
// asserts that agent reaches state 'done' before a timeout.
//
// Wire protocol (matched exactly to ../fleethost.mjs):
//   parent -> child : { t: 'dispatch', id, task, cwd }
//   child  -> parent: { type: 'ready' }                       (once, on startup)
//                     { type: 'agent', id, state, ... }       (per-agent updates)
//   state transitions: 'working' -> 'done' | 'failed'
//
// Note on "read-mode": fleethost gates tools to a read-only SAFE set
// (Read/Glob/Grep/WebSearch/...), so EVERY dispatched agent is inherently
// read-only — there is no separate 'mode' field on the dispatch message. A
// trivial "list the files" task therefore exercises exactly the read path.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HOST = path.join(ROOT, "fleethost.mjs");

// Mirror main.cjs's NODE_BIN convention; default to the node running this test.
const NODE = process.env.NODE_BIN || process.execPath;

const READY_TIMEOUT_MS = 15_000;   // host module import + startup handshake
const DONE_TIMEOUT_MS = 120_000;   // one real agent turn over the network
const AGENT_ID = "T-1";
const TASK = "List the files here in one sentence.";

async function run() {
  // Spawn exactly like main.cjs: plain node + a 4th 'ipc' stdio slot so that
  // process.send / 'message' work across the boundary.
  const child = spawn(NODE, [HOST], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });

  let stderr = "";
  if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

  const result = await new Promise((resolve) => {
    let readyTimer = setTimeout(() => {
      resolve({ ok: false, why: `no {type:'ready'} within ${READY_TIMEOUT_MS}ms` });
    }, READY_TIMEOUT_MS);
    let doneTimer = null;

    child.on("error", (e) => resolve({ ok: false, why: `spawn error: ${e.message}` }));
    child.on("exit", (code, signal) =>
      resolve({ ok: false, why: `host exited early (code=${code}, signal=${signal})` }));

    child.on("message", (m) => {
      if (!m) return;

      if (m.type === "ready") {
        clearTimeout(readyTimer);
        doneTimer = setTimeout(() => {
          resolve({ ok: false, why: `agent did not reach 'done' within ${DONE_TIMEOUT_MS}ms` });
        }, DONE_TIMEOUT_MS);
        // Dispatch a single read-only agent on the trivial task.
        child.send({ t: "dispatch", id: AGENT_ID, task: TASK, cwd: ROOT });
        return;
      }

      if (m.type === "agent" && m.id === AGENT_ID) {
        if (m.state === "done") {
          clearTimeout(doneTimer);
          resolve({ ok: true });
        } else if (m.state === "failed") {
          clearTimeout(doneTimer);
          resolve({ ok: false, why: `agent failed: ${m.summary || "(no summary)"}` });
        }
      }
    });
  });

  try { child.kill(); } catch { /* already gone */ }

  if (result.ok) {
    console.log("PASS");
    process.exit(0);
  }

  const detail = stderr.trim() ? `\n--- host stderr ---\n${stderr.trim()}` : "";
  console.error(`FAIL: ${result.why}${detail}`);
  process.exit(1);
}

run();
