// tap-runner.mjs - Hermes reflex ganglion. Runs a codex worker headless and
// TAPS the station on completion by appending one line to .atlas/taps.ndjson.
// Push, not pull: ATLAS never has to poll the agent to know it finished.
// Usage: node scripts/tap-runner.mjs --id B-x [--cwd dir] [--timeout-min 25]
// Env: TAP_TASK (prompt), TAP_MODEL, TAP_SANDBOX (default read-only),
//      TAP_COMMIT_PROMPT (optional single resume leg for commit duty).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ID = arg('id', 'B-anon');
const CWD = arg('cwd', process.env.ATLAS_REPO || process.cwd());
const TIMEOUT_MS = Number(arg('timeout-min', '25')) * 60 * 1000;
const MODEL = process.env.TAP_MODEL || 'claude-haiku-4-5-20251001';
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
  return ['exec', '--json', '--color', 'never', '--ignore-user-config', '--model', MODEL];
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

// Main leg: fresh session, read-only sandbox, prompt last.
const s1 = await runLeg([...baseArgs(), '-C', CWD, '-s', SANDBOX, TASK], 'main');
// Optional single commit leg via resume (only on success and only if requested).
if (COMMIT_PROMPT && s1.state === 'success' && s1.threadId) {
  await runLeg(['exec', 'resume', '--json', '--color', 'never', '--ignore-user-config', '--model', MODEL, '-s', SANDBOX, s1.threadId, COMMIT_PROMPT], 'commit');
} else if (COMMIT_PROMPT && s1.state === 'success') {
  console.log('[tap] commit leg skipped: no threadId captured');
}
process.exit(s1.state === 'success' ? 0 : 1);
