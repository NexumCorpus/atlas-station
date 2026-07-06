'use strict';
const fs = require('fs');
const path = require('path');
const FILE = 'notifications.ndjson';

function _load(dir) {
  try {
    return fs.readFileSync(path.join(dir, FILE), 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function _save(notifs, dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const _fp = path.join(dir, FILE);
  fs.writeFileSync(_fp + '.tmp', notifs.map(n => JSON.stringify(n)).join('\n') + (notifs.length ? '\n' : ''), 'utf8');
  fs.renameSync(_fp + '.tmp', _fp);
}

function notify(text, type, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const notifs = _load(dir);
  const n = { id: 'N-' + Date.now(), ts: new Date().toISOString(), text, type: type || 'info', read: false };
  notifs.push(n);
  _save(notifs, dir);
  return n;
}

function getUnread(dir) {
  dir = dir || path.join(__dirname, 'memory');
  return _load(dir).filter(n => !n.read);
}

function markRead(id, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const notifs = _load(dir);
  notifs.forEach(n => { if (n.id === id || id === '*') n.read = true; });
  _save(notifs, dir);
}

module.exports = { notify, getUnread, markRead };
