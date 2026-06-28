'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'memory');
const SESSION_FILE = 'sessions.ndjson';
const MAX_SESSIONS = 10;

function loadLastSession(dir) {
  dir = dir || DEFAULT_DIR;
  try {
    const file = path.join(dir, SESSION_FILE);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}

function writeSession(session, dir) {
  dir = dir || DEFAULT_DIR;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SESSION_FILE);
    fs.appendFileSync(file, JSON.stringify(session) + '\n', 'utf8');
  } catch (_) {}
}

function buildSessionContext(dir) {
  const last = loadLastSession(dir);
  if (!last) return '';
  const d = String(last.ts || '').slice(0, 10);
  const cost = last.totalCost != null ? ` ($${Number(last.totalCost).toFixed(2)})` : '';
  const agents = last.agentCount ? ` · ${last.agentCount} agents` : '';
  const topics = last.topics && last.topics.length ? `\nTopics: ${last.topics.join(', ')}` : '';
  const note = last.note ? `\nNote to self: ${last.note}` : '';
  return `[Last Session — ${d}${cost}${agents}]${topics}${note}`;
}

module.exports = { loadLastSession, writeSession, buildSessionContext };
