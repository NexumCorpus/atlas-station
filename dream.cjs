'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DREAM_FILE = (dir) => path.join(dir, 'dreams.ndjson');
const DREAM_RECEIPT_FILE = (dir) => path.join(dir, 'dream-receipts.ndjson');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function writeDream(report, memDir) {
  const entry = {
    ts: new Date().toISOString(),
    patterns: report.patterns || [],
    insights: report.insights || [],
    proposals: report.proposals || [],
    mood: report.mood || 'neutral',
  };
  fs.appendFileSync(DREAM_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadDreams(memDir, maxN = 5) {
  const f = DREAM_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .slice(-maxN);
}

function writeDreamReceipt(receipt, memDir) {
  const input = receipt.input == null ? null : String(receipt.input);
  const output = receipt.output == null ? null : String(receipt.output);
  const entry = {
    ts: new Date().toISOString(),
    dreamId: receipt.dreamId || null,
    pulseCount: receipt.pulseCount ?? null,
    attempt: receipt.attempt ?? 1,
    event: receipt.event || 'terminal',
    state: receipt.state || null,
    task: receipt.task || null,
    input,
    inputSha256: receipt.inputSha256 || (input == null ? null : sha256(input)),
    inputBytes: receipt.inputBytes ?? (input == null ? 0 : Buffer.byteLength(input, 'utf8')),
    output,
    outputSha256: receipt.outputSha256 || (output == null ? null : sha256(output)),
    outputBytes: receipt.outputBytes ?? (output == null ? 0 : Buffer.byteLength(output, 'utf8')),
    error: receipt.error || null,
    exit: receipt.exit || null,
    source: receipt.source || 'dream-protocol',
  };
  fs.appendFileSync(DREAM_RECEIPT_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadDreamReceipts(memDir, maxN = 10) {
  const f = DREAM_RECEIPT_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .slice(-maxN);
}

/**
 * Balanced top-level JSON object scan. Respects string/escape state so
 * braces inside strings never desync depth.
 */
function _balancedJsonObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function _validateDreamReport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'candidate is not an object' };
  const missing = [];
  for (const k of ['patterns', 'insights', 'proposals']) if (!Array.isArray(obj[k])) missing.push(k);
  if (missing.length) return { ok: false, reason: 'missing or mistyped fields: ' + missing.join(',') };
  for (const p of obj.proposals) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !(p.title || p.description)) return { ok: false, reason: 'malformed proposal entry (needs title or description)' };
  }
  return { ok: true, value: {
    patterns: obj.patterns.map(String).slice(0, 10),
    insights: obj.insights.map(String).slice(0, 10),
    proposals: obj.proposals.slice(0, 6),
    mood: typeof obj.mood === 'string' && obj.mood ? obj.mood : 'processing',
  } };
}

/**
 * Validated dream-output parsing. The old inline greedy brace-match
 * (/\{[\s\S]*\}/) spanned prose and [PROPOSALS] lines, and its silent
 * catch{} stubbed every parse failure into an empty "processing"
 * reflection with no trace - 23 accumulated before diagnosis. This
 * parser tries fenced blocks first, then balanced objects, validates the
 * shape, and records WHY each candidate failed so failures become
 * inspectable receipt state instead of silence.
 */
function parseDreamReport(text) {
  const t = String(text || '');
  const attempts = [];
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const bare = _balancedJsonObjects(t);
  for (const candidate of [...fenced, ...bare]) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch (e) {
      attempts.push({ via: 'json-parse', ok: false, reason: String(e.message).slice(0, 120) });
      continue;
    }
    const v = _validateDreamReport(parsed);
    attempts.push({ via: fenced.indexOf(candidate) >= 0 ? 'fenced' : 'balanced', ok: v.ok, reason: v.ok ? null : v.reason });
    if (v.ok) return { ok: true, report: v.value, attempts };
  }
  if (!attempts.length) attempts.push({ via: 'scan', ok: false, reason: 'no fenced block or balanced JSON object found' });
  return { ok: false, report: null, attempts };
}

/**
 * Merge prior dream reflections into the RECENT JOURNAL feed so pulses
 * inherit their predecessors instead of re-deriving them. Stub rows
 * (mood "processing") are excluded: they carry no reflection.
 */
function inheritJournal(recentJournal, priorDreams) {
  const rows = Array.isArray(recentJournal) ? recentJournal.slice() : [];
  const dreams = (Array.isArray(priorDreams) ? priorDreams : [])
    .filter((d) => d && d.mood && d.mood !== 'processing');
  for (const d of dreams) {
    const parts = [];
    if (Array.isArray(d.patterns) && d.patterns.length) parts.push(d.patterns.slice(0, 2).join(" | "));
    if (Array.isArray(d.insights) && d.insights.length) parts.push(d.insights.slice(0, 2).join(" | "));
    if (!parts.length) continue;
    rows.push({ ts: d.ts, note: '[dream] ' + parts.join(' :: ') });
  }
  return rows;
}
module.exports = { writeDream, loadDreams, parseDreamReport, inheritJournal, writeDreamReceipt, loadDreamReceipts, sha256 };
