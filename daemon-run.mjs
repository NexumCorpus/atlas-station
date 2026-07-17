// Autonomous ATLAS session — runs on a schedule without the Electron app.
// Launches fleethost, sends a self-directed session prompt, logs the result.
import { spawn, execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DIR  = "E:\\atlas-station";
const LOG  = join(DIR, "memory", "daemon-log.ndjson");
const TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes
const DRY_RUN = process.argv.includes('--dry-run'); // validates plumbing without a full ATLAS session

const PROMPT = `This is an autonomous session. Daniel is not present. You are waking up on a schedule to do self-directed work.

Work through this in order — stop when the session budget is spent or when there is nothing actionable left:

0. daemon_health() — check that the scheduler is healthy. Log the result but don't stop if it's stale; that's self-referential.
1. triage_proposals() — score pending proposals, auto-reject noise. Then load_proposals() to see what's HIGH.
2. If there are HIGH pending proposals: auto_build(priority:"HIGH", limit:2). Do not build more than 2 in one daemon session.
3. project_status() — check active projects. If any project is waiting on work you can do autonomously, advance it.
4. ALWAYS run the grounded improvement cycle — every session, unconditionally:
   a) call build_outcomes() to collect last 10 builds and identify the most common failure patterns
   b) call load_proposals() to see what is already pending (skip duplicates)
   c) if you see a clear failure pattern not already addressed by a pending proposal, queue 1-2 targeted proposals via propose_improvement, each naming the specific failure pattern it addresses
   d) if last dream > 6h ago: write ONE capture_insight(category:"dream") summarizing the patterns observed across recent sessions — it MUST start with "OBSERVED: " then patterns, then "THEREFORE: " then proposals. This is the narrative record.
   The improvement cycle runs regardless of how many proposals were already built this session. Continual improvement is the primary purpose of daemon sessions.
5. build_outcomes() was already called in step 4 — use those results to report build quality. If success rate < 80%, immediately propose a fix targeting the specific failure mode.
6. Write one sentence in journal_write summarizing what this daemon session did.

Standing rules:
- Never spawn more than 2 build agents in one daemon session.
- Never write a dream without first calling build_outcomes() to ground it in observed failure data.
- After any merge, call both verify_build() AND run_tests() — if run_tests returns FAIL, you MUST attempt repair:
  1. Spawn a build agent with the failing test output as context: "These tests are failing after the last merge: [test output]. Fix the root cause."
  2. After the repair agent completes, call run_tests() again.
  3. If tests now pass: log success and continue. If still failing: call revert_build() on the last merge, then notify_self() with what happened and why. Stop further builds this session.
  4. Maximum 1 repair attempt per failed build. If repair itself fails to merge, notify_self and stop.
- If you find something important Daniel should know, use notify_self(text, type:"alert").
- Be decisive. Do real work if there is real work to do. If everything is done, say so briefly and exit.`;

function writeLog(entry) {
  try {
    const memDir = join(DIR, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch (_) {}
}

// NREM memory consolidation — fire-and-forget after each daemon session.
// Strengthens co-activated memory edges, applies proportional decay, detects conflicts.
function runNREM(dir) {
  try {
    const proc = spawn(NODE, [join(dir, "scripts", "nrem-consolidation.mjs"), dir], {
      cwd: dir, stdio: "pipe", detached: false
    });
    proc.on("error", () => {});
    proc.stdout.on("data", d => writeLog({ event: "nrem-output", text: d.toString().trim() }));
  } catch (_) {}
}

writeLog({ event: "daemon-start" });

// Auto-merge any unmerged fleet/* branches before the session begins
try {
  const branches = execFileSync("git", ["-C", DIR, "branch", "--list", "fleet/*"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map(b => b.replace(/^[\s*+]+/, ""));
  for (const branch of branches) {
    try {
      execFileSync("git", ["-C", DIR, "merge-base", "--is-ancestor", branch, "master"], { stdio: "pipe" });
      // Already ancestor of master — skip (already merged or will be pruned)
    } catch (_) {
      // Not yet in master — merge it
      try {
        execFileSync("git", ["-C", DIR, "merge", "--no-edit", "-m", "daemon-startup: auto-merge " + branch, branch], { cwd: DIR });
        writeLog({ event: "startup-auto-merge", branch });
        console.log("[daemon] auto-merged unmerged branch:", branch);
      } catch (mergeErr) {
        writeLog({ event: "startup-merge-failed", branch, error: String(mergeErr.message || mergeErr).slice(0, 200) });
      }
    }
  }
} catch (scanErr) {
  writeLog({ event: "startup-branch-scan-failed", error: String(scanErr.message || scanErr).slice(0, 120) });
}

const host = spawn(NODE, ["fleethost.mjs"], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  env: process.env,
  cwd: DIR
});

let done = false;
let restartAttempts = 0;
const MAX_RESTARTS = 1;

// Message handler factory — takes the live process ref so send() goes to the right host
function makeMessageHandler(proc) {
  return (m) => {
    if (m.type === "ready") {
      if (DRY_RUN) {
        writeLog({ event: "dry-run-ready" });
        console.log("[daemon] dry-run: fleethost started OK, IPC ready. Exiting.");
        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        process.exit(0);
      }
      proc.send({ t: "say", text: PROMPT });
      writeLog({ event: "prompt-sent" });
    } else if (m.type === "agent" && m.id === "ATLAS") {
      if ((m.state === "done" || m.state === "failed") && !done) {
        done = true;
        const reply = (m.reply || m.summary || "(no reply)").slice(0, 3000);
        writeLog({ event: "daemon-done", state: m.state, reply });
        runNREM(DIR);
        try {
          const _ot = _require('./outcome-tracker.cjs');
          const _def = _require('./deferred.cjs');
          const outcomes = _ot.getOutcomes(join(DIR, 'memory'));
          const recentMergeConflicts = outcomes.slice(-5).filter(o => o.rating === 'bad' && o.failureMode === 'merge_conflict');
          if (recentMergeConflicts.length > 0) {
            _def.deferTask(
              'Retry merge-conflict builds: ' + recentMergeConflicts.map(o => o.agentId).join(', ') + '. Use staged_verify_build first, then re-attempt.',
              {
                reason: 'Auto-deferred by daemon: merge_conflict recovery',
                blocker: 'Recent build outcomes include merge_conflict failures that were not repaired in the daemon turn',
                nextAction: 'Run staged_verify_build for the listed agent ids, then retry the merge-conflict builds',
                validationCondition: 'Each retried build either passes staged verification or records a fresh blocker with the failing command output',
              },
              join(DIR, 'memory')
            );
            writeLog({ event: 'merge-conflict-deferred', ids: recentMergeConflicts.map(o => o.agentId) });
          }
        } catch {}
        console.log("[daemon] ATLAS", m.state, "—", reply.slice(0, 200));
        try { proc.kill(); } catch (_) {}
        process.exit(0);
      }
    }
  };
}

host.on("message", makeMessageHandler(host));
if (host.stderr) host.stderr.on("data", (b) => process.stderr.write("[host] " + b));

const timer = setTimeout(() => {
  writeLog({ event: "daemon-timeout" });
  console.log("[daemon] timeout after 25m");
  try { host.kill(); } catch (_) {}
  process.exit(1);
}, TIMEOUT_MS);

host.on("exit", (code) => {
  if (!done) {
    writeLog({ event: "host-exited-early", code, restartAttempts });
    clearTimeout(timer);
    if (restartAttempts < MAX_RESTARTS) {
      restartAttempts++;
      writeLog({ event: "daemon-restart", attempt: restartAttempts });
      console.log("[daemon] host exited early — restarting (attempt " + restartAttempts + ")");
      const retry = spawn(NODE, ["fleethost.mjs"], { stdio: ["pipe","pipe","pipe","ipc"], env: process.env, cwd: DIR });
      retry.on("message", makeMessageHandler(retry)); // fix: send() targets the live retry process
      if (retry.stderr) retry.stderr.on("data", (b) => process.stderr.write("[host-retry] " + b));
      retry.on("exit", () => { if (!done) { writeLog({ event: "retry-exited-early" }); process.exit(1); } });
    } else {
      process.exit(1);
    }
  }
});
