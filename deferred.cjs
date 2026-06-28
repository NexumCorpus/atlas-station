'use strict';
const fs = require('fs');
const path = require('path');
const FILE = 'deferred.ndjson';

function _load(dir) {
  try {
    return fs.readFileSync(path.join(dir, FILE), 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function _save(tasks, dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
}

function deferTask(task, reason, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const tasks = _load(dir);
  const entry = { id: 'D-' + Date.now(), ts: new Date().toISOString(), task, reason: reason || '', state: 'pending' };
  tasks.push(entry);
  _save(tasks, dir);
  return entry;
}

function popPending(dir) {
  dir = dir || path.join(__dirname, 'memory');
  const tasks = _load(dir);
  const pending = tasks.filter(t => t.state === 'pending');
  const rest = tasks.filter(t => t.state !== 'pending');
  // Mark all pending as claimed
  pending.forEach(t => { t.state = 'claimed'; t.claimedTs = new Date().toISOString(); });
  _save([...rest, ...pending], dir);
  return pending;
}

function listDeferred(dir) {
  dir = dir || path.join(__dirname, 'memory');
  return _load(dir);
}

// Non-destructive peek at pending deferred tasks — for startup briefing/status
function peekPending(dir) {
  dir = dir || path.join(__dirname, 'memory');
  return _load(dir).filter(t => t.state === 'pending');
}

module.exports = { deferTask, popPending, listDeferred, peekPending };
