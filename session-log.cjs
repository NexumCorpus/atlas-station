'use strict';
const fs = require('fs');
const path = require('path');
const circulation = require('./circulation.cjs');
const LOG_FILE = (dir) => path.join(dir, 'session_turns.ndjson');
const MAX_TURNS = 20; // rolling window

function appendTurn(text, memDir, hermes = null) {
  const entry = { ts: new Date().toISOString(), text: text.slice(0, 1200),
    hermes: circulation.envelope(hermes, 'transform', 'session-log') }; // cap per turn
  const file = LOG_FILE(memDir);
  let existing = [];
  try {
    if (fs.existsSync(file)) {
      existing = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  existing.push(entry);
  // Keep rolling window
  if (existing.length > MAX_TURNS) existing = existing.slice(-MAX_TURNS);
  fs.writeFileSync(file + '.tmp', existing.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function getRecentTurns(memDir, n) {
  const file = LOG_FILE(memDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-(n || 10)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function clearLog(memDir) {
  const file = LOG_FILE(memDir);
  if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
}

module.exports = { appendTurn, getRecentTurns, clearLog };
