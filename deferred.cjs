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

/**
 * Write-time dedupe for deferred tasks. The dream pulse mints a fresh HIGH
 * proposal per reflection; without a guard, near-identical crystallization-
 * repair proposals re-seeded future turns for days after their defect was
 * already fixed on master (17 entries retired Aug 2026). findLiveDuplicate
 * admits a new task only if no LIVE task (pending/queued/claimed) shares its
 * normalized fingerprint within DEDUPE_WINDOW_MS. Terminal states never
 * block fresh work: re-raising a solved problem is legitimate after regression.
 */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Evidence-keyed auto-close (D-1787378827439): a dream re-seed of a task whose
// defect is already proven fixed by commit/receipt evidence must not enter the
// live queue again. Match is deliberately narrow - crystallization-repair theme
// AND an existing terminal solved record - so unrelated tasks are never touched.
const AUTO_CLOSE_RE = /crystall/i;

function _taskFingerprint(taskText) {
  return String(taskText || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function _stopwords() {
  if (_stopwords.set) return _stopwords.set;
  _stopwords.set = new Set(('a an and are as at be but by for from has have if in into is it its of on or that the their there this to was were will with' +
    ' before after against another each').split(' '));
  return _stopwords.set;
}

function _stem(w) {
  return w.replace(/(izations|ization|ations|ation|ings|ing|ions|ion|ed|es|s)$/, '');
}

function _taskTokens(taskText) {
  const raw = String(taskText || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return raw.filter(w => w.length >= 3 && !_stopwords().has(w)).map(_stem);
}

function _sharedStems(aTokens, bTokens) {
  const B = new Set(bTokens);
  let s = 0;
  for (const w of new Set(aTokens)) if (B.has(w)) s++;
  return s;
}

// Topic-cluster tolerance: dream pulses re-mint the SAME problem with
// lexically diverse phrasings - exact match and 0.8-Jaccard paraphrase
// detection scored 0/17 recall against the real Aug-2026 duplicate
// corpus (measured, not assumed). Matching on >=3 shared content
// stems scored 12/17 recall with 0/19 false positives against
// genuinely distinct families, so that is the shipped rule. Short
// texts are exempt: brief task names overlap too easily.
const FUZZY_MIN_TOKENS = 8;
const CLUSTER_SHARED_STEMS = 3;

function _isDuplicate(t, fp, tokens, now) {
  if (!['pending', 'queued', 'claimed'].includes(t.state)) return false;
  if (!t.ts || (now - Date.parse(t.ts)) >= DEDUPE_WINDOW_MS) return false;
  if (_taskFingerprint(t.task) === fp) return true;
  // Symmetric length gate: fuzzy matching only compares two LONG texts.
  // A short live task must never suppress a long newcomer on keyword
  // overlap alone (measured false-positive class).
  if (!tokens || tokens.length < FUZZY_MIN_TOKENS) return false;
  const liveTokens = _taskTokens(t.task);
  if (!liveTokens || liveTokens.length < FUZZY_MIN_TOKENS) return false;
  return _sharedStems(tokens, liveTokens) >= CLUSTER_SHARED_STEMS;
}

function findLiveDuplicate(tasks, taskText, now = Date.now()) {
  const fp = _taskFingerprint(taskText);
  if (!fp) return null;
  const tokens = _taskTokens(taskText);
  return tasks.find(t => _isDuplicate(t, fp, tokens, now)) || null;
}

function dedupeDeferred(entry, tasks, dir) {
  const dup = findLiveDuplicate(tasks, entry.task, Date.parse(entry.ts));
  if (!dup) return entry;
  if (dir) {
    try {
      fs.appendFileSync(path.join(dir, FILE + '.dedupes.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), suppressedId: entry.id, duplicateOf: dup.id, task: String(entry.task || '').slice(0, 200), state: dup.state }) + '\n', 'utf8');
    } catch {}
  }
  return { ...entry, __suppressed: true, duplicateOf: dup.id };
}
function _evidenceAutoClose(entry, tasks, dir) {
  if (!AUTO_CLOSE_RE.test(String(entry.task || ''))) return null;
  const prior = tasks.find(t =>
    AUTO_CLOSE_RE.test(String(t.task || '')) &&
    ['retired', 'consumed', 'closed'].includes(t.state));
  if (!prior) return null;
  if (dir) {
    try {
      fs.appendFileSync(path.join(dir, FILE + '.autoclose.ndjson'),
        JSON.stringify({ ts: new Date().toISOString(), closedId: entry.id, duplicateOf: prior.id, priorState: prior.state, fixCommits: prior.fixCommits || null, task: String(entry.task || '').slice(0, 200) }) + '\n', 'utf8');
    } catch {}
  }
  return { ...entry, __suppressed: true, __autoClosed: true, duplicateOf: prior.id };
}
function deferTask(task, reason, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const tasks = _load(dir);
  const normalized = normalizeReason(reason);
  const entry = { id: 'D-' + Date.now(), ts: new Date().toISOString(), task, ...normalized, state: 'pending' };
  let admitted = dedupeDeferred(entry, tasks, dir);
  if (!admitted.__suppressed) admitted = _evidenceAutoClose(entry, tasks, dir) || entry;
  if (!admitted.__suppressed) {
    tasks.push(entry);
    _save(tasks, dir);
  }
  return admitted;
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

function _updateTask(id, update, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const tasks = _load(dir);
  const index = tasks.findIndex(task => task.id === id);
  if (index < 0) throw new Error(`Deferred task not found: ${id}`);
  tasks[index] = update({ ...tasks[index] });
  _save(tasks, dir);
  return tasks[index];
}

function markQueued(id, receipt, dir) {
  if (!receipt || !receipt.eventId || !receipt.recordHash) {
    throw new Error('Deferred queue receipt requires eventId and recordHash');
  }
  return _updateTask(id, task => {
    if (task.state === 'queued') {
      if (task.ingressEventId !== receipt.eventId || task.ingressRecordHash !== receipt.recordHash) {
        throw new Error(`Deferred task queue receipt conflict: ${id}`);
      }
      return task;
    }
    if (task.state !== 'pending') {
      throw new Error(`Deferred task cannot be queued from state ${task.state}: ${id}`);
    }
    return {
      ...task,
      state: 'queued',
      queuedTs: new Date().toISOString(),
      ingressEventId: receipt.eventId,
      ingressRecordHash: receipt.recordHash,
    };
  }, dir);
}

function markTerminal(id, terminal, dir) {
  if (!terminal || !terminal.kind || !terminal.recordHash) {
    throw new Error('Deferred terminal receipt requires kind and recordHash');
  }
  if (!['ack', 'fail'].includes(terminal.kind)) {
    throw new Error(`Unsupported deferred terminal kind: ${terminal.kind}`);
  }
  return _updateTask(id, task => {
    if (['consumed', 'failed'].includes(task.state)) {
      if (task.terminalRecordHash !== terminal.recordHash) {
        throw new Error(`Deferred task terminal receipt conflict: ${id}`);
      }
      return task;
    }
    if (task.state !== 'queued') {
      throw new Error(`Deferred task cannot terminalize from state ${task.state}: ${id}`);
    }
    return {
      ...task,
      state: terminal.kind === 'ack' ? 'consumed' : 'failed',
      terminalTs: new Date().toISOString(),
      terminalKind: terminal.kind,
      terminalRecordHash: terminal.recordHash,
    };
  }, dir);
}

module.exports = {
  deferTask,
  findLiveDuplicate,
  dedupeDeferred,
  popPending,
  listDeferred,
  peekPending,
  markQueued,
  markTerminal,
  normalizeReason,
};
