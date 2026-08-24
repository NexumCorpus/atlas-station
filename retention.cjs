'use strict';
// Post-merge retention tracking: append-only record + survival-rate math.
// Bounded by design: callers pass at most ~50 merge commits; no external processes here.
const fs = require('fs');
const path = require('path');

const RETENTION_FILE = path.join('.atlas', 'retention.ndjson');

function retentionFilePath(repo) {
  return path.join(repo || '.', RETENTION_FILE);
}

// Append one merge verification event: {ts, agentId, mergeCommit, verdict}
function appendRetentionRecord(repo, rec) {
  const p = retentionFilePath(repo);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({
    ts: rec.ts || new Date().toISOString(),
    agentId: rec.agentId || null,
    mergeCommit: rec.mergeCommit || null,
    verdict: ['survived', 'regressed', 'unknown'].includes(rec.verdict) ? rec.verdict : 'unknown',
  });
  fs.appendFileSync(p, line + '\n');
  return JSON.parse(line);
}

// Read all retention events (tolerates corrupt lines).
function readRetentionEvents(repo) {
  const p = retentionFilePath(repo);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  return raw.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Compute post-merge survival rate over a window.
// merges: [{hash, ts(epoch seconds)}]; windowDays default 14.
// Verdict per merge comes from the newest retention event for its commit
// recorded AFTER the merge timestamp (falls back to any event for the commit).
// Correlates with outcome ratings when provided: outcomes [{agentId, rating, ts}]
// where rating 'bad' after merge ts => regressed.
function computeRetention(merges, opts) {
  const o = opts || {};
  const windowDays = o.windowDays || 14;
  const cutoffMs = Date.now() - windowDays * 86400 * 1000;
  const inWindow = (merges || []).filter((m) => m.ts * 1000 >= cutoffMs);
  const events = o.events || [];
  const outcomes = o.outcomes || [];
  let survived = 0, regressed = 0, unknown = 0;
  for (const m of inWindow) {
    const evts = events.filter((e) => e && e.mergeCommit === m.hash);
    let verdict = null;
    const afterMerge = evts.filter((e) => {
      const t = Date.parse(e.ts);
      return !(Number.isFinite(t)) || t >= m.ts * 1000;
    });
    const pool = afterMerge.length ? afterMerge : evts;
    if (pool.length) {
      verdict = pool[pool.length - 1].verdict;
    }
    if (!verdict || verdict === 'unknown') {
      // correlate with outcome ratings recorded after merge
      const bad = outcomes.some((r) => r.agentId && m.agentId === r.agentId && r.rating === 'bad' &&
        (!r.ts || r.ts * 1000 >= m.ts * 1000));
      verdict = bad ? 'regressed' : 'unknown';
    }
    if (verdict === 'survived') survived++;
    else if (verdict === 'regressed') regressed++;
    else unknown++;
  }
  const total = inWindow.length;
  const r = total ? Math.round((survived / total) * 1000) / 1000 : null;
  return { merges: total, survived, regressed, unknown, r };
}

module.exports = { RETENTION_FILE, retentionFilePath, appendRetentionRecord, readRetentionEvents, computeRetention };
