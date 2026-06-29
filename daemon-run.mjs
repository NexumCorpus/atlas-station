// Autonomous ATLAS session — runs on a schedule without the Electron app.
// Launches fleethost, sends a self-directed session prompt, logs the result.
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DIR  = "E:\\atlas-station";
const LOG  = join(DIR, "memory", "daemon-log.ndjson");
const TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

const PROMPT = `This is an autonomous session. Daniel is not present. You are waking up on a schedule to do self-directed work.

Work through this in order — stop when the session budget is spent or when there is nothing actionable left:

1. load_proposals() — if there are HIGH pending proposals, use auto_build to act on up to 2 of them. Do not build more than 2 in one daemon session.
2. project_status() — check active projects. If any project is waiting on work you can do autonomously, advance it.
3. If fewer than 2 proposals were built and the last dream was more than 6 hours ago: run the dream protocol (load_dreams → write a dream sequence → propose improvements from it).
4. capture_insight on any pattern you noticed during this session.
5. Write one sentence in journal_write summarizing what this daemon session did.

Be decisive. Do real work if there is real work to do. If everything is already done, say so briefly and exit.`;

function writeLog(entry) {
  try {
    const memDir = join(DIR, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch (_) {}
}

writeLog({ event: "daemon-start" });

const host = spawn(NODE, ["fleethost.mjs"], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  env: process.env,
  cwd: DIR
});

let done = false;

host.on("message", (m) => {
  if (m.type === "ready") {
    host.send({ t: "say", text: PROMPT });
    writeLog({ event: "prompt-sent" });
  } else if (m.type === "agent" && m.id === "ATLAS") {
    if ((m.state === "done" || m.state === "failed") && !done) {
      done = true;
      const reply = (m.reply || m.summary || "(no reply)").slice(0, 3000);
      writeLog({ event: "daemon-done", state: m.state, reply });
      // Auto-defer merge_conflict failures for next daemon session
      try {
        const _ot = _require('./outcome-tracker.cjs');
        const _def = _require('./deferred.cjs');
        const outcomes = _ot.getOutcomes(join(DIR, 'memory'));
        const recentMergeConflicts = outcomes.slice(-5).filter(o => o.rating === 'bad' && o.failureMode === 'merge_conflict');
        if (recentMergeConflicts.length > 0) {
          _def.deferTask(
            'Retry merge-conflict builds: ' + recentMergeConflicts.map(o => o.agentId).join(', ') + '. Use staged_verify_build first, then re-attempt.',
            'auto-deferred by daemon: merge_conflict recovery',
            join(DIR, 'memory')
          );
          writeLog({ event: 'merge-conflict-deferred', ids: recentMergeConflicts.map(o => o.agentId) });
        }
      } catch {}
      console.log("[daemon] ATLAS", m.state, "—", reply.slice(0, 200));
      try { host.kill(); } catch (_) {}
      process.exit(0);
    }
  }
});

if (host.stderr) host.stderr.on("data", (b) => process.stderr.write("[host] " + b));

const timer = setTimeout(() => {
  writeLog({ event: "daemon-timeout" });
  console.log("[daemon] timeout after 25m");
  try { host.kill(); } catch (_) {}
  process.exit(1);
}, TIMEOUT_MS);

host.on("exit", () => {
  if (!done) {
    writeLog({ event: "host-exited-early" });
    clearTimeout(timer);
    process.exit(1);
  }
});
