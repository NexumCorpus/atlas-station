const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// OpenAI shim: serve POST /v1/chat/completions off a REAL local `claude` CLI
// print-mode call (subscription-billed, no API keys). Lets OpenRouter-shaped
// tools (RDE first) put the station's own lineage in the model seat while
// their engines stay byte-identical.
//
// Invocation lore ported from director2-harness/director/llm/claude_cli.py
// (hard-won live findings):
//  * user prompt over STDIN (Windows argv caps near 32k chars)
//  * a `.cmd`/`.bat` shim must run via ["cmd","/c",exe] (CreateProcess can't)
//  * --tools "" (CLI is agentic by default, would spin on tool attempts)
//  * --setting-sources "" (child must NOT inherit user output styles)
//  * strip ANTHROPIC_*/CLAUDE_CODE* from child env so the CLI can never
//    silently fall back to metered API billing (subscription quota is the
//    entire point); CLAUDE_CODE_OAUTH_TOKEN is the one allowed pass-through
//  * CLAUDE_CODE_MAX_OUTPUT_TOKENS floor 32k (CLI HARD-FAILS past the cap)

const TIMEOUT_MS = 180_000;
const STRIP_RE = /^(ANTHROPIC_|CLAUDE_?CODE|CLAUDECODE|CLAUDE_AGENT)/;

// --- locate the claude executable (PATH lookup, Windows-aware) --------------
function findClaude() {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
    if (!isWin) {
      const p = path.join(dir, 'claude');
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function buildArgv(exe, model, system) {
  let argv = [exe];
  if (/\.(cmd|bat)$/i.test(exe)) argv = ['cmd', '/c', exe]; // CreateProcess can't run .cmd
  argv.push('-p', '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '', '--setting-sources', '',
    '--no-session-persistence');
  if (model) argv.push('--model', String(model));
  if (system) argv.push('--system-prompt', system);
  return argv;
}

function childEnv() {
  const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIP_RE.test(k)) env[k] = v;
  }
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token; // subscription auth pass-through
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000';
  return env;
}

// --- one CLI call: prompt over stdin, JSON envelope back --------------------
function callClaude({ model, system, user }) {
  return new Promise((resolve, reject) => {
    const exe = findClaude();
    if (!exe) return reject(new Error('claude CLI not found on PATH'));
    const [cmd, ...args] = buildArgv(exe, model, system);
    let child;
    try {
      child = spawn(cmd, args, { env: childEnv(), windowsHide: true });
    } catch (e) {
      return reject(new Error(`claude CLI failed to launch: ${e.message}`));
    }
    let stdout = '', stderr = '', done = false;
    const finish = (fn, val) => { if (!done) { done = true; clearTimeout(timer); fn(val); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, new Error(`claude CLI timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, new Error(`claude CLI failed to launch: ${e.message}`)));
    child.stdin.on('error', () => { /* EPIPE if child died early; exit path reports */ });
    child.stdin.end(user);
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(reject, new Error(
          `claude CLI exit ${code}: ${(stderr || stdout || '').slice(0, 400)}`));
      }
      let data;
      try { data = JSON.parse(stdout); } catch {
        return finish(reject, new Error(
          `claude CLI returned non-JSON envelope: ${(stdout || stderr || '').slice(0, 400)}`));
      }
      if (data.is_error) {
        return finish(reject, new Error(`claude CLI error result: ${String(data.result).slice(0, 400)}`));
      }
      const text = String(data.result || '');
      if (!text.trim()) {
        return finish(reject, new Error(`claude CLI returned an empty result (subtype=${data.subtype || '?'})`));
      }
      const u = data.usage || {};
      const promptTokens = (u.input_tokens | 0) + (u.cache_read_input_tokens | 0)
        + (u.cache_creation_input_tokens | 0);
      finish(resolve, {
        text,
        usage: {
          prompt_tokens: promptTokens || 0,
          completion_tokens: (u.output_tokens | 0) || 0,
          total_tokens: (promptTokens || 0) + ((u.output_tokens | 0) || 0),
        },
      });
    });
  });
}

// --- OpenAI messages -> {system, user} ---------------------------------------
function translate(messages) {
  const system = messages.filter((m) => m && m.role === 'system')
    .map((m) => contentText(m.content)).join('\n\n');
  // Fold the non-system turns into one prompt; label only when there's a
  // multi-turn history so a single user message stays byte-clean.
  const turns = messages.filter((m) => m && m.role !== 'system');
  let user;
  if (turns.length === 1) {
    user = contentText(turns[0].content);
  } else {
    user = turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m.content)}`).join('\n\n');
  }
  return { system, user };
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {           // OpenAI content-parts form
    return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return c == null ? '' : String(c);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// --- server ------------------------------------------------------------------
async function startShim({ port = 0 } = {}) {
  let queue = Promise.resolve(); // serialize: one claude process at a time

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: `no route: ${req.method} ${req.url}` });
    }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        return sendJson(res, 400, { error: 'request body is not valid JSON' });
      }
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return sendJson(res, 400, { error: 'messages: non-empty array required' });
      }
      const model = typeof body.model === 'string' ? body.model : '';
      const { system, user } = translate(body.messages);
      const t0 = Date.now();
      queue = queue
        .then(() => callClaude({ model, system, user }))
        .then((out) => {
          process.stderr.write(`[shim] model=${model || 'cli-default'} ${Date.now() - t0}ms ok\n`);
          sendJson(res, 200, {
            id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'cli-default',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: out.text },
              finish_reason: 'stop',
            }],
            usage: out.usage,
          });
        })
        .catch((e) => {
          process.stderr.write(`[shim] model=${model || 'cli-default'} ${Date.now() - t0}ms FAIL ${e.message}\n`);
          try { sendJson(res, 502, { error: e.message }); } catch { /* client gone */ }
        });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      // Drop keep-alive sockets first, then let the loop settle a beat after
      // the close callback: callers (tests) may process.exit() immediately,
      // and on Windows an exit racing half-closed handles trips a libuv
      // assertion (async.c: !(handle->flags & UV_HANDLE_CLOSING)).
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => setTimeout(resolve, 100));
    }),
  };
}

module.exports = { startShim };
