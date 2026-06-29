'use strict';
const fs = require('fs');
const path = require('path');
const CRYSTALS_FILE = (dir) => path.join(dir, 'crystals.ndjson');

function appendCrystal(text, turnRange, memDir) {
  const dir = memDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entry = { ts: new Date().toISOString(), text: text.trim(), turnRange, session: process.pid };
  fs.appendFileSync(CRYSTALS_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadCrystals(memDir, maxN = 3) {
  const f = CRYSTALS_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-maxN).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function countCrystals(memDir) {
  const f = CRYSTALS_FILE(memDir);
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length;
}

module.exports = { appendCrystal, loadCrystals, countCrystals };
