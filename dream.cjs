'use strict';
const fs = require('fs');
const path = require('path');

const DREAM_FILE = (dir) => path.join(dir, 'dreams.ndjson');

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

module.exports = { writeDream, loadDreams };
