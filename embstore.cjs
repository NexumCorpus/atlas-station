// embstore.cjs — Sidecar embedding store: {id, emb:[...384 floats]}.
// Stored at memory/fact-embeddings.ndjson alongside facts.jsonl.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'memory');
const EMB_FILE = 'fact-embeddings.ndjson';

function _loadEmbs(dir) {
  const p = path.join(dir, EMB_FILE);
  if (!fs.existsSync(p)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (e.id && e.emb) map.set(e.id, e.emb); } catch {}
  }
  return map;
}

function setEmb(id, emb, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, EMB_FILE), JSON.stringify({ id, emb }) + '\n', 'utf8');
}

function getEmb(id, dir = DEFAULT_DIR) {
  return _loadEmbs(dir).get(id) || null;
}

function getAllEmbs(dir = DEFAULT_DIR) {
  return _loadEmbs(dir);
}

// Compact: remove duplicates (keep last entry per id)
function compactEmbs(dir = DEFAULT_DIR) {
  const map = _loadEmbs(dir);
  const lines = [...map.entries()].map(([id, emb]) => JSON.stringify({ id, emb }));
  fs.writeFileSync(path.join(dir, EMB_FILE), lines.join('\n') + '\n', 'utf8');
  return map.size;
}

module.exports = { setEmb, getEmb, getAllEmbs, compactEmbs };
