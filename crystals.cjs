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

module.exports = { appendCrystal, loadCrystals, countCrystals };
