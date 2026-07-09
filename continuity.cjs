const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function pin(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/\\/g, '/').toLowerCase();
}

function loadShardRows(ledgerPath) {
  try {
    return fs.readFileSync(ledgerPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeGroup(rows) {
  const first = rows[0] || {};
  return {
    pin: first.crystal_pin,
    fragments: rows.length,
    k: Number(first.k) || null,
    n: Number(first.n) || null,
    recoverable: Number(first.k) > 0 && rows.length >= Number(first.k),
  };
}

/**
 * Report whether the CURRENT bytes of a file are represented by a recoverable
 * shard group. A valid older snapshot is deliberately reported as stale rather
 * than being mistaken for current recovery coverage.
 */
function inspectFile(filePath, options = {}) {
  const ledgerPath = options.ledgerPath || 'E:/station/shards.jsonl';
  const normalized = normalizePath(filePath);
  if (!fs.existsSync(filePath)) {
    return { status: 'missing', file: filePath, ledgerPath, currentPin: null, snapshots: [] };
  }

  const bytes = fs.readFileSync(filePath);
  const currentPin = pin(bytes);
  const groups = new Map();
  for (const row of loadShardRows(ledgerPath)) {
    if (!row.path || !row.crystal_pin || normalizePath(row.path) !== normalized) continue;
    if (!groups.has(row.crystal_pin)) groups.set(row.crystal_pin, []);
    groups.get(row.crystal_pin).push(row);
  }
  const snapshots = [...groups.values()].map(summarizeGroup);
  const current = snapshots.find((snapshot) => snapshot.pin === currentPin);

  if (current) {
    return {
      status: current.recoverable ? 'fresh' : 'incomplete',
      file: filePath,
      ledgerPath,
      bytes: bytes.length,
      currentPin,
      snapshot: current,
      snapshots,
    };
  }
  return {
    status: snapshots.length ? 'stale' : 'unsharded',
    file: filePath,
    ledgerPath,
    bytes: bytes.length,
    currentPin,
    snapshots,
  };
}

function formatStatus(report) {
  if (report.status === 'fresh') {
    return `FRESH ${path.basename(report.file)} pin=${report.currentPin} ${report.snapshot.k}-of-${report.snapshot.n}`;
  }
  if (report.status === 'stale') {
    const latest = report.snapshots[report.snapshots.length - 1];
    return `STALE ${path.basename(report.file)} current=${report.currentPin} latest_snapshot=${latest.pin} (${latest.k}-of-${latest.n})`;
  }
  if (report.status === 'unsharded') return `UNSHARDED ${path.basename(report.file)} pin=${report.currentPin}`;
  if (report.status === 'incomplete') return `INCOMPLETE ${path.basename(report.file)} pin=${report.currentPin}`;
  return `MISSING ${path.basename(report.file)}`;
}

module.exports = { inspectFile, formatStatus, loadShardRows };
