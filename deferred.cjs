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
  const _fp = path.join(dir, FILE);
  fs.writeFileSync(_fp + '.tmp', tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
  fs.renameSync(_fp + '.tmp', _fp);
}

function _clean(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function _isWeak(s) {
  const v = _clean(s).toLowerCase();
  return !v || v.length < 8 || /^(n\/a|none|null|unknown|scheduled|deferred|todo|later|test reason)$/.test(v);
}

function _extractLine(text, label) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'im');
  const m = String(text || '').match(re);
  return m ? _clean(m[1]) : '';
}

function normalizeReason(reason) {
  let summary = '';
  let blocker = '';
  let nextAction = '';
  let validationCondition = '';

  if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
    summary = _clean(reason.reason || reason.summary || reason.why || '');
    blocker = _clean(reason.blocker || '');
    nextAction = _clean(reason.nextAction || reason.next_action || '');
    validationCondition = _clean(
      reason.validationCondition ||
      reason.validation_condition ||
      reason.retryCondition ||
      reason.retry_condition ||
      ''
    );
  } else {
    const text = String(reason || '').trim();
    blocker = _extractLine(text, 'Blocker');
    nextAction = _extractLine(text, 'Next action');
    validationCondition =
      _extractLine(text, 'Validation condition') ||
      _extractLine(text, 'Retry condition');
    summary = _clean(text
      .split(/\r?\n/)
      .filter(line => !/^\s*(Blocker|Next action|Validation condition|Retry condition)\s*:/i.test(line))
      .join(' '));
  }

  if (_isWeak(blocker) || _isWeak(nextAction) || _isWeak(validationCondition)) {
    throw new Error('Deferred task requires a meaningful blocker, next action, and validation condition');
  }

  const parts = [];
  if (summary && !_isWeak(summary)) parts.push(summary);
  parts.push(`Blocker: ${blocker}`);
  parts.push(`Next action: ${nextAction}`);
  parts.push(`Validation condition: ${validationCondition}`);
  const cause = summary && !_isWeak(summary) ? summary : blocker;
  return { reason: parts.join('\n'), cause, blocker, nextAction, validationCondition, retryCondition: validationCondition };
}

function deferTask(task, reason, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const tasks = _load(dir);
  const normalized = normalizeReason(reason);
  const entry = { id: 'D-' + Date.now(), ts: new Date().toISOString(), task, ...normalized, state: 'pending' };
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

module.exports = { deferTask, popPending, listDeferred, peekPending, normalizeReason };
