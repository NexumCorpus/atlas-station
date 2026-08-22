// tap-runner.mjs - Hermes reflex ganglion. Runs a codex worker headless and
// TAPS the station on completion by appending one line to .atlas/taps.ndjson.
// Push, not pull: ATLAS never has to poll the agent to know it finished.
// Usage: node scripts/tap-runner.mjs --id B-x [--cwd dir] [--timeout-min 25]
// Env: TAP_TASK (prompt), TAP_MODEL, TAP_SANDBOX (default read-only),
//      TAP_COMMIT_PROMPT (optional single resume leg for commit duty).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ID = arg('id', 'B-anon');
const CWD = arg('cwd', process.env.ATLAS_REPO || process.cwd());
const TIMEOUT_MS = Number(arg('timeout-min', '25')) * 60 * 1000;
const MODEL = process.env.TAP_MODEL || 'gpt-5.6-luna';
const SANDBOX = process.env.TAP_SANDBOX || 'read-only'; // never danger-full-access
const TASK = process.env.TAP_TASK;
const COMMIT_PROMPT = process.env.TAP_COMMIT_PROMPT || '';
if (!TASK) { console.error('[tap] TAP_TASK required'); process.exit(2); }

function resolveCodexBin() { // mirrors providers/codex-cli.mjs resolution
  if (process.env.ATLAS_CODEX_BIN) return process.env.ATLAS_CODEX_BIN;
  try {
    const root = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    if (existsSync(root)) {
      const vers = readdirSync(root).filter(d => !d.startsWith('.'));
      for (const v of vers) {
        const cand = join(root, v, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existsSync(cand)) return cand;
      }
    }
  } catch {}
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

const TAP_FILE = join(process.env.ATLAS_REPO || 'E:/atlas-station', '.atlas', 'taps.ndjson');
function tap(rec) {
  mkdirSync(join(TAP_FILE, '..'), { recursive: true });
  appendFileSync(TAP_FILE, JSON.stringify(rec) + '\n');
  console.log('[tap]', JSON.stringify(rec).slice(0, 240));
}

function baseArgs() {
  return ['exec', '--json', '--color', 'never', '--ignore-user-config', '--skip-git-repo-check', '--model', MODEL];
}
async function runLeg(args, legName) {
  return new Promise((resolve) => {
    const bin = resolveCodexBin();
    const t0 = Date.now();
    let threadId = null, resultText = '', state = 'failed';
    console.log(`[tap:${legName}] spawn`, bin);
    const p = spawn(bin, args, { cwd: CWD, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const killer = setTimeout(() => { try { p.kill('kill'); } catch {} }, TIMEOUT_MS);
    let carry = '';
    p.stdout.on('data', d => {
      carry += d.toString('utf8');
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'thread.started' && e.thread_id) threadId = e.thread_id;
          if (e.type === 'item.completed' && e.item?.type === 'agent_message') resultText = e.item.text || resultText;
          if (e.type === 'error') resultText = (resultText + ' ' + (e.message || '')).trim();
        } catch {}
      }
    });
    p.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.log(`[tap:${legName}:err]`, t.slice(0, 200)); });
    p.on('close', (code) => {
      clearTimeout(killer);
      state = code === 0 && resultText ? 'success' : 'failed';
      tap({ ts: new Date().toISOString(), agentId: ID + (legName === 'commit' ? '-commit' : ''), threadId, state, summary: String(resultText).slice(0, 300), exitCode: code, ms: Date.now() - t0 });
      resolve({ state, threadId });
    });
  });
}

// ---------- OpenRouter leg: the stations OWN model as worker brain ----------
const OR_API = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODEL = process.env.TAP_OR_MODEL || process.env.ATLAS_OPENROUTER_MODEL || "stealth/ox-alpha";
let orMsgs = null; // kept across main->commit legs

function loadOrKey() {
  try {
    const root = process.env.ATLAS_REPO || "E:/atlas-station";
    const line = readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).find(x => x.startsWith("OPENROUTER_API_KEY="));
    if (!line) return null;
    return line.split("=").slice(1).join("=").trim().replace(/^["']|['"]$/g, ""); // value NEVER printed
  } catch { return null; }
}
function withinRoot(p) { const rp = resolve(p); const rt = resolve(CWD); return rp === rt || rp.startsWith(rt + sep); }

const OR_TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a file inside the working directory. Text files return contents; images (.png/.jpg/.gif/.webp) are attached as pictures you can see.", parameters: { type: "object", properties: { path: { type: "string", description: "file path, absolute or relative to working dir" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_dir", description: "List entries of a directory inside the working directory.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "write_file", description: "Write a file. DENIED in this sandbox - exists only so the worker knows the boundary.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path","content"] } } }
];
async function orChat(messages, key) {
  const r = await fetch(OR_API, { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OR_MODEL, max_tokens: 3000, messages, tools: OR_TOOLS }) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("unparseable provider response");
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 200));
  const c = j.choices && j.choices[0] && j.choices[0].message;
  if (!c) throw new Error("no choices in response");
  return c;
}

async function runOrTurns(key, maxRounds) {
  for (let round = 0; round < maxRounds; round++) {
    const m = await orChat(orMsgs, key);
    if (process.env.TAP_DEBUG) console.log('[tap:dbg] round', round, '| tool_calls:', JSON.stringify((m.tool_calls||[]).map(c=>c.function.name+'('+String(c.function.arguments).slice(0,100)+')')), '| content:', String(m.content==null?'':m.content).slice(0,180));
    const tcs = m.tool_calls;
    if (!tcs || !tcs.length) return String(m.content == null ? "" : m.content);
    orMsgs.push({ role: "assistant", content: m.content || "", tool_calls: tcs });
    for (const c of tcs) {
      let out = "";
      let imageFollowUp = null;
      try {
        const a = JSON.parse(c.function.arguments || "{}");
        if (c.function.name === "read_file") {
          if (!a.path) { orMsgs.push({ role: "tool", tool_call_id: c.id, content: "ERROR: path required - e.g. {\"path\": \"package.json\"} (relative to working dir)" }); continue; }
          const rp = resolve(a.path || "");
          if (!withinRoot(rp)) out = "DENIED: outside working directory";
          else if (/\.(png|jpe?g|gif|webp)$/i.test(rp)) {
            const b64 = readFileSync(rp).toString("base64");
            const ext = (rp.match(/\.([a-z0-9]+)$/i) || [, "png"])[1].toLowerCase();
            const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
            orMsgs.push({ role: "tool", tool_call_id: c.id, content: "[image attached in next message]" });
            imageFollowUp = { role: "user", content: [
              { type: "text", text: "Tool read_file returned this image: " + rp },
              { type: "image_url", image_url: { url: "data:image/" + mime + ";base64," + b64 } }] };
          } else {
            const st2 = statSync(rp);
            if (st2.size > 400000) out = "file too large (" + st2.size + " bytes)";
            else out = readFileSync(rp, "utf8");
          }
        } else if (c.function.name === "list_dir") {
          const rp = resolve(CWD, a.path || ".");
          if (!withinRoot(rp)) out = "DENIED: outside working directory";
          else out = readdirSync(rp).join("\n");
        } else if (c.function.name === "write_file") {
          out = "DENIED: openrouter leg is read-only by design (non-overstepping norm)";
        } else out = "unknown tool: " + c.function.name;
      } catch (e) { out = "ERROR: " + e.message; }
      if (imageFollowUp) { orMsgs.push(imageFollowUp); continue; }
      orMsgs.push({ role: "tool", tool_call_id: c.id, content: String(out).slice(0, 60000) });
    }
  }
  return null; // round-cap exhaustion -> caller reports failure honestly
}

async function orLeg(legName, taskOverride) {
  const t0 = Date.now();
  const key = loadOrKey();
  if (!key) {
    tap({ ts: new Date().toISOString(), agentId: ID + (legName === "main" ? "" : "-" + legName), threadId: null, route: "openrouter", state: "failed", summary: "no OPENROUTER_API_KEY in .env", exitCode: 1, ms: Date.now() - t0 });
    return { state: "failed" };
  }
  try {
    if (!orMsgs) {
      const sandboxLine = SANDBOX === "read-only"
        ? "The sandbox is READ-ONLY: write_file is permanently denied."
        : "The sandbox allows workspace access, but this leg is still read-only in v1.";
      orMsgs = [{ role: "system", content:
        "You are a Hermes fleet worker (id " + ID + ") executing a task inside " + CWD + "." +
        " Tools available: read_file (text AND images - images arrive as attached pictures), list_dir." +
        " All paths MUST stay inside the working directory; anything else is denied." +
        " " + sandboxLine +
        " Work until the task is complete, then reply with the final answer as PLAIN TEXT with NO tool calls." },
        { role: "user", content: taskOverride || TASK }];
    } else orMsgs.push({ role: "user", content: taskOverride });
    const result = await runOrTurns(key, legName === "main" ? 12 : 6);
    const ok = !!(result && result.trim());
    tap({ ts: new Date().toISOString(), agentId: ID + (legName === "main" ? "" : "-" + legName), threadId: null, route: "openrouter", model: OR_MODEL, state: ok ? "success" : "failed", summary: String(result || "round cap exhausted or empty reply").slice(0, 300), exitCode: ok ? 0 : 1, ms: Date.now() - t0 });
    return { state: ok ? "success" : "failed" };
  } catch (e) {
    tap({ ts: new Date().toISOString(), agentId: ID + (legName === "main" ? "" : "-" + legName), threadId: null, route: "openrouter", model: OR_MODEL, state: "failed", summary: String(e.message || e).slice(0, 300), exitCode: 1, ms: Date.now() - t0 });
    return { state: "failed" };
  }
}

// ---------- Route dispatch ----------
const ROUTE = process.env.TAP_ROUTE || "auto"; // auto | openrouter | codex
let finalState = "failed";
if (ROUTE === "openrouter") {
  const r = await orLeg("main");
  if (COMMIT_PROMPT && r.state === "success") await orLeg("commit", COMMIT_PROMPT);
  finalState = r.state;
} else if (ROUTE === "codex") {
  const s1 = await runLeg([...baseArgs(), "-C", CWD, "-s", SANDBOX, TASK], "main");
  if (COMMIT_PROMPT && s1.state === "success" && s1.threadId) {
    await runLeg(["exec", "resume", "--json", "--color", "never", "--ignore-user-config", "--skip-git-repo-check", "--model", MODEL, "-s", SANDBOX, s1.threadId, COMMIT_PROMPT], "commit");
  } else if (COMMIT_PROMPT && s1.state === "success") {
    console.log("[tap] commit leg skipped: no threadId captured");
  }
  finalState = s1.state;
} else { // auto: codex first, own-model fallback
  const s1 = await runLeg([...baseArgs(), "-C", CWD, "-s", SANDBOX, TASK], "main");
  if (s1.state === "success") {
    if (COMMIT_PROMPT && s1.threadId) {
      await runLeg(["exec", "resume", "--json", "--color", "never", "--ignore-user-config", "--skip-git-repo-check", "--model", MODEL, "-s", SANDBOX, s1.threadId, COMMIT_PROMPT], "commit");
    }
    finalState = "success";
  } else {
    console.log("[tap] codex leg failed -> falling back to own model (openrouter)");
    const r = await orLeg("fallback");
    if (COMMIT_PROMPT && r.state === "success") await orLeg("commit", COMMIT_PROMPT);
    finalState = r.state;
  }
}
process.exit(finalState === "success" ? 0 : 1);
