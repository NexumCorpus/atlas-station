'use strict';
const fs = require('fs');
const path = require('path');

const ROUTINES_FILE = (dir) => path.join(dir, 'routines.ndjson');

// A routine step: { tool: string, args: object, description: string }
function saveRoutine(name, description, steps, memDir) {
  const all = listRoutines(memDir).filter(r => r.name !== name);
  all.push({ name, description, steps, ts: new Date().toISOString() });
  fs.writeFileSync(ROUTINES_FILE(memDir), all.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function getRoutine(name, memDir) {
  return listRoutines(memDir).find(r => r.name === name) || null;
}

function deleteRoutine(name, memDir) {
  const remaining = listRoutines(memDir).filter(r => r.name !== name);
  fs.writeFileSync(ROUTINES_FILE(memDir), remaining.map(r => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : ''), 'utf8');
}

function listRoutines(memDir) {
  const f = ROUTINES_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { saveRoutine, getRoutine, deleteRoutine, listRoutines };
