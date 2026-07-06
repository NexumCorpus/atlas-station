'use strict';
const fs = require('fs');
const path = require('path');

const GOALS_FILE = 'goals.ndjson';

function _load(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, GOALS_FILE), 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function _save(goals, dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const _fp = path.join(dir, GOALS_FILE);
  fs.writeFileSync(_fp + '.tmp', goals.map(g => JSON.stringify(g)).join('\n') + '\n', 'utf8');
  fs.renameSync(_fp + '.tmp', _fp);
}

function addGoal(text, priority, area, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const goals = _load(dir);
  const goal = { id: 'G-' + Date.now(), ts: new Date().toISOString(), text, priority: priority || 'medium', area: area || 'general', state: 'active' };
  goals.push(goal);
  _save(goals, dir);
  return goal;
}

function listGoals(dir) {
  dir = dir || path.join(__dirname, 'memory');
  return _load(dir);
}

function resolveGoal(id, outcome, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const goals = _load(dir);
  const g = goals.find(g => g.id === id);
  if (!g) return null;
  g.state = outcome === 'done' ? 'done' : 'abandoned';
  g.resolvedTs = new Date().toISOString();
  _save(goals, dir);
  return g;
}

module.exports = { addGoal, listGoals, resolveGoal };
