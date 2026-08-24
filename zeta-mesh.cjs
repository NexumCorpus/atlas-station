#!/usr/bin/env node
'use strict';
/* zeta-mesh.cjs - Zeta parallel worker mesh organ for Hermes/ATLAS.
 * CLI: node zeta-mesh.cjs run --task "<text>" --angles <n> --rounds <k>
 * Module exports runMesh(opts) with injectable fetchImpl + receiptPath for tests.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'stealth/ox-alpha';
const WORKER_TIMEOUT_MS = 120000;
const RECEIPT_PATH_DEFAULT = 'E:\\station\\zeta-mesh.ndjson';
const ENV_PATH_DEFAULT = 'E:\\atlas-station\\.env';

function loadApiKey(envPath) {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const m = raw.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (e) { /* absent .env is tolerated; env var fallback */ }
  return process.env.OPENROUTER_API_KEY || null;
}

function loadModel() {
  return process.env.ATLAS_OPENROUTER_MODEL || DEFAULT_MODEL;
}

const ANGLE_PROMPTS = [
  'first-principles decomposition',
  'adversarial critique / failure hunting',
  'systems & feedback-loop view',
  'minimalist reduction to essentials',
  'temporal / sequencing view',
  'resource & constraint accounting',
  'analogy transfer from a distant domain',
  'stakeholder / interface view',
];

function angleFor(i) {
  return ANGLE_PROMPTS[i % ANGLE_PROMPTS.length] + (' #' + (i + 1));
}

function systemPrompt(angle, round, peers) {
  let p = `You are a ZETA mesh worker. Angle: ${angle}. Mesh round ${round}. ` +
    'Reply in DENSE GLYPH form: use \u00a7-coded symbolic compressed lines (terse, structured, no prose), ' +
    'then end with a line exactly "PLAIN:" followed by a plain-language expansion of the glyphs. ' +
    'Glyph section must be strictly shorter than the plain section.';
  if (round > 1 && peers && peers.length) {
    p += '\nPEER OUTPUTS FROM PREVIOUS ROUND (critique and refine yours against them):\n' +
      peers.map((x, i) => `--- peer ${i + 1} ---\n${x}`).join('\n');
  }
  return p;
}

async function callOnce(messages, model, apiKey, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WORKER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) {
      const err = new Error('http_' + res.status);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    return { text, usage: j.usage || null };
  } finally { clearTimeout(t); }
}

async function callWorker(messages, model, apiKey, fetchImpl) {
  try {
    return await callOnce(messages, model, apiKey, fetchImpl);
  } catch (e) {
    const retryable = e && (e.status === 429 || (e.status >= 500 && e.status < 600));
    if (!retryable) throw e;
    await new Promise(r => setTimeout(r, 1000));
    return callOnce(messages, model, apiKey, fetchImpl);
  }
}

// Split glyph vs plain sections; compression ratio = glyphChars / plainChars.
function splitReply(text) {
  const idx = text.indexOf('PLAIN:');
  let glyph = text, plain = '';
  if (idx >= 0) {
    glyph = text.slice(0, idx).trim();
    plain = text.slice(idx + 6).trim();
  } else {
    plain = glyph; glyph = '';
  }
  const ratio = plain.length > 0 ? +(glyph.length / plain.length).toFixed(3) : null;
  return { glyph, plain, ratio };
}

function settleAll(promises) {
  return Promise.all(promises.map(p => p.then(
    v => ({ ok: true, v }),
    e => ({ ok: false, e: (e && e.message) || String(e) })
  )));
}

async function runMesh(opts) {
  const task = opts.task;
  const angles = Math.max(1, opts.angles | 0 || 1);
  const rounds = Math.min(Math.max(1, opts.rounds | 0 || 2), 5);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const receiptPath = opts.receiptPath || RECEIPT_PATH_DEFAULT;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : loadApiKey(opts.envPath || ENV_PATH_DEFAULT);
  const model = opts.model || loadModel();
  const t0 = Date.now();

  if (!apiKey && !opts.fetchImpl) throw new Error('OPENROUTER_API_KEY not found');

  const transcript = [];
  // worker state: per-worker message history
  const workers = [];
  for (let i = 0; i < angles; i++) {
    workers.push({ i, angle: angleFor(i), messages: [], dead: false, usage: null, ratio: null });
  }

  for (let round = 1; round <= rounds; round++) {
    const alive = workers.filter(w => !w.dead);
    const peerTexts = alive.map(w => w.lastText || '');
    const results = await settleAll(alive.map(async w => {
      w.messages.push({ role: 'system', content: systemPrompt(w.angle, round, round > 1 ? peerTexts : null) });
      w.messages.push({ role: 'user', content: round === 1 ? task : 'Critique/refine your answer given peers above.' });
      const r = await callWorker(w.messages, model, apiKey, fetchImpl);
      w.messages.push({ role: 'assistant', content: r.text });
      return { w, r };
    }));
    for (let ri = 0; ri < results.length; ri++) {
      const res = results[ri];
      const w = alive[ri];
      if (!res.ok) {
        w.dead = true;
        transcript.push({ kind: 'worker-death', round, angle: w.angle, error: res.e });
        continue;
      }
      const r = res.v.r;
      w.lastText = r.text;
      if (r.usage) w.usage = r.usage;
      const sp = splitReply(r.text);
      w.ratio = sp.ratio;
      w.plain = sp.plain;
      transcript.push({ kind: 'worker', round, angle: w.angle, text: r.text });
    }
    if (workers.every(w => w.dead)) break;
  }

  const survivors = workers.filter(w => !w.dead);
  if (survivors.length === 0) {
    const rec = { ts: new Date().toISOString(), status: 'total-failure', survivors: 0 };
    appendReceipt(receiptPath, rec, []);
    throw new Error('all mesh workers died');
  }

  // merge
  const mergeMessages = [
    { role: 'system', content: 'You are the ZETA mesh synthesizer. Merge the workers\u2019 final answers into ONE coherent answer in plain language.' },
    { role: 'user', content: 'TASK: ' + task + '\n\nWORKER ANSWERS:\n' + survivors.map((w, i) => `[worker ${i + 1}]\n${w.lastText}`).join('\n\n') },
  ];
  const merged = await callWorker(mergeMessages, model, apiKey, fetchImpl);
  transcript.push({ kind: 'merge', text: merged.text });

  const wallMs = Date.now() - t0;
  const seqWall = Math.max(wallMs, 1); // avoid /0 on sub-ms runs
  const sequentialEstimateMs = seqWall * survivors.length; // naive same-cost sequential estimate
  const receipt = {
    ts: new Date().toISOString(),
    organ: 'zeta-mesh',
    task,
    model,
    angles,
    rounds,
    survivors: survivors.length,
    deaths: workers.length - survivors.length,
    wallClockMs: wallMs,
    sequentialEstimateMs,
    speedup: +(sequentialEstimateMs / seqWall).toFixed(2),
    workers: workers.map(w => ({ angle: w.angle, dead: !!w.dead, usage: w.usage, compressionRatio: w.ratio })),
    merged: merged.text,
    verified: false, // grader.cjs decides; we only record artifact hash
  };
  appendReceipt(receiptPath, receipt, transcript);
  return receipt;
}

function appendReceipt(receiptPath, receipt, transcript) {
  const fullTranscript = JSON.stringify({ receipt, transcript });
  receipt.transcriptSha256 = crypto.createHash('sha256').update(fullTranscript).digest('hex');
  const dir = path.dirname(receiptPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(receiptPath, JSON.stringify({ ...receipt, transcript }) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') out.task = argv[++i];
    else if (argv[i] === '--angles') out.angles = parseInt(argv[++i], 10);
    else if (argv[i] === '--rounds') out.rounds = parseInt(argv[++i], 10);
  }
  return out;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd !== 'run') {
    console.error('usage: node zeta-mesh.cjs run --task "<text>" --angles <n> --rounds <k>');
    process.exit(1);
  }
  const a = parseArgs(process.argv.slice(3));
  if (!a.task) { console.error('--task required'); process.exit(1); }
  runMesh({ task: a.task, angles: a.angles || 3, rounds: a.rounds || 2 })
    .then(r => {
      console.log('merged:', r.merged);
      for (const w of r.workers) console.log(`worker [${w.angle}] dead=${w.dead} ratio=${w.compressionRatio}`);
      console.log('speedup:', r.speedup, 'transcriptSha256:', r.transcriptSha256);
    })
    .catch(e => { console.error('mesh failed:', e.message); process.exit(1); });
}

module.exports = { runMesh, splitReply, angleFor, loadApiKey, parseArgs, RECEIPT_PATH_DEFAULT };
