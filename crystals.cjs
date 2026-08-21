'use strict';
const fs = require('fs');
const path = require('path');
const circulation = require('./circulation.cjs');
const CRYSTALS_FILE = (dir) => path.join(dir, 'crystals.ndjson');

function appendCrystal(text, turnRange, memDir, hermes = null) {
  const dir = memDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entry = { ts: new Date().toISOString(), text: String(text ?? '').trim(), turnRange, session: process.pid,
    hermes: circulation.envelope(hermes, 'memory-write', 'crystals') };
  fs.appendFileSync(CRYSTALS_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadCrystals(memDir, maxN = 3) {
  const f = CRYSTALS_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  const limit = maxN == null ? 3 : Math.max(0, Math.floor(Number(maxN) || 0));
  if (limit === 0) return [];
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function countCrystals(memDir) {
  const f = CRYSTALS_FILE(memDir);
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length;
}

const CRYSTAL_FAILURES_FILE = (dir) => path.join(dir, 'crystal-failures.ndjson');

/**
 * Record a failed crystallization as a structured, retryable handoff.
 * Replaces the old fire-and-forget catch{} that swallowed failures silently.
 * Each receipt carries the turn, error identity, retryability, and status so a
 * later session can resume distillation instead of re-deriving what broke.
 */
function appendCrystalFailure(body, memDir) {
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  const { turnNum = null, crystalId = null, error = null, retryable = false, status = 'pending_retry' } = body || {};
  const entry = {
    ts: new Date().toISOString(),
    kind: 'crystal-failure',
    turnNum,
    crystalId,
    error: {
      name: error && error.name || null,
      message: error && String(error.message || '').slice(0, 500) || null,
    },
    retryable: Boolean(retryable),
    status,
    session: process.pid,
    hermes: circulation.envelope(null, 'memory-write', 'crystal-failures'),
  };
  fs.appendFileSync(CRYSTAL_FAILURES_FILE(memDir), JSON.stringify(entry) + String.fromCharCode(10), 'utf8');
  return entry;
}

/** Load recent crystallization failures (newest last unless maxN given). */
function loadCrystalFailures(memDir, maxN = 10) {
  const f = CRYSTAL_FAILURES_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean);
  const limit = maxN == null ? 10 : Math.max(0, Math.floor(Number(maxN) || 0));
  if (limit === 0) return [];
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Provider-error banners sometimes arrive as SUCCESSFUL results (observed
 * 2026-08-11: the usage-limit banner was stored verbatim as a crystal).
 * Detection is deliberately banner-specific - a genuine crystal that merely
 * DISCUSSES usage limits must never be rejected. Short-text guard: banners
 * are compact; long texts are only scanned at head/tail.
 */
const PROVIDER_ERROR_PATTERNS = [
  /usage limit[^\n]*try again at/i,
  /(purchase|buy)[^\n]{0,40}credits/i,
  /^you'?ve hit your usage limit/i,
  /visit https?:\/\/\S*(settings\/usage|explore\/pro)/i,
  /^api error/i,
  /^error:/i,
];
function isProviderErrorText(text) {
  if (!text) return false;
  const s = String(text);
  if (s.length > 500) {
    return PROVIDER_ERROR_PATTERNS.some(re => re.test(s.slice(0, 200)) || re.test(s.slice(-200)));
  }
  return PROVIDER_ERROR_PATTERNS.some(re => re.test(s));
}

module.exports = { appendCrystal, loadCrystals, countCrystals, appendCrystalFailure, loadCrystalFailures, isProviderErrorText };
