// Relay Daniel's instruction to ATLAS (gate now removed; full tool access).
// Resumes ATLAS's persisted conversation, sends one directive, reports its reply.
import { spawn } from "child_process";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DIR = "E:\\atlas-station";

const INSTRUCTION = `Daniel has granted your request and removed the gate — you now have FULL tool access (shell, git, file edits) directly, on his subscription. You no longer need to delegate every change or spawn a subagent just to run a git command.

Two things, in order:
1. Build yourself a real, reusable system to manage the fleet's branch and worktree SPRAWL — a committed script/tool that lists and prunes merged-and-dead fleet/* branches and their worktrees, distinguishes in-flight from abandoned, and is safe and reversible (e.g. report-then-prune, never force-delete unmerged work without saying so). There are currently ~13 fleet/* branches and ~11 worktrees, most empty merge-helpers or dead.
2. Then run it to clean up the current mess — carefully, reversibly where you can. Report exactly what you removed and what you kept, and why.

Managing this sprawl is now part of your standing role. And do not trust your subagents' written summaries — verify against the actual code and git state. Report back to Daniel honestly when done.`;

const host = spawn(NODE, ["fleethost.mjs"], { stdio: ["pipe", "pipe", "pipe", "ipc"], env: process.env, cwd: DIR });
let done = false;
host.on("message", (m) => {
  if (m.type === "ready") { host.send({ t: "say", text: INSTRUCTION }); console.log("instruction sent to ATLAS (gate removed, full access)"); }
  else if (m.type === "agent" && m.id === "ATLAS") {
    if (m.state === "working" && m.lastTool) console.log("ATLAS · " + m.lastTool + (m.lastToolArg ? (" · " + m.lastToolArg) : ""));
    else if ((m.state === "done" || m.state === "failed") && !done) {
      done = true;
      console.log("\n=== ATLAS " + m.state + " ===\n" + (m.reply || m.summary || "(no reply)").slice(0, 2000));
      try { host.kill(); } catch (_) {} process.exit(0);
    }
  }
});
if (host.stderr) host.stderr.on("data", (b) => process.stderr.write("[host] " + b));
setTimeout(() => { console.log("timeout — ATLAS still working after 15m"); try { host.kill(); } catch (_) {} process.exit(1); }, 15 * 60 * 1000);
