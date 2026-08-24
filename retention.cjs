#!/usr/bin/env node
'use strict';
// retention-r measurement organ: fraction of auto-merge commits whose changes survive later evolution.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.ATLAS_REPO || process.cwd();
const MEM = path.join(REPO, 'memory');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Walk master history over window; collect merge/revert commits with touched files.
function walkHistory(windowDays) {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const out = git(['log', '--diff-merges=first-parent', '--name-only', '--format=%H|%ct|%s', '--since=' + new Date(since * 1000).toISOString()]);
  const commits = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{40})\|(\d+)\|(.*)$/);
    if (m) {
      cur = { hash: m[1], ct: Number(m[2]), subject: m[3], files: [] };
      if (/auto-merge fleet\/B-\d+|revert/i.test(m[3])) commits.push(cur);
    } else if (cur && cur.files !== undefined && commits.includes(cur)) {
      cur.files.push(line.trim());
    }
  }
  // fix: only attach file lines to tracked commits Ã¢â‚¬â€ reset cur when untracked commit header seen
  const seen = [];
  cur = null;
  const tracked = new Set();
  for (const c of commits) tracked.add(c.hash);
  const rebuilt = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\|(\d+)\|(.*)$/);
    if (m) { cur = tracked.has(m[1]) ? { hash: m[1], ct: Number(m[2]), subject: m[3], files: [] } : null; if (cur) rebuilt.push(cur); }
    else if (cur && line.trim()) cur.files.push(line.trim());
  }
  return rebuilt;
}

// Lines added by merge commit M to file F.
function addedLines(commitHash, file) {
  try {
    const diff = git(['show', '-M', '--unified=0', '--format=', commitHash, '--', file]);
    const added = [];
    for (const line of diff.split(/\r?\n/)) if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1).trim()).length ? added.push : null;
  } catch (_) {}
}

function computeRetention({ windowDays = 30 } = {}) {
  const merges = walkHistory(windowDays);
  const perFile = [];
  const daysToOverwrite = [];

  for (const M of merges) {
    for (const F of M.files) {
      // Revert detection: a later commit whose message references reverting this merge's branch
      let revertedBy = null;
      let overwritten = false;
      const branchMatch = M.subject.match(/fleet\/([\w-]+)/);
      let logLater = '';
      try {
        logLater = git(['log', '--format=%H|%ct|%s', `${M.hash}..HEAD`, '--', F]);
      } catch (_) { continue; }
      const laterCommits = [];
      let c = null;
      for (const line of logLater.split(/\r?\n/)) {
        const m2 = line.match(/^([0-9a-f]{40})\|(\d+)\|(.*)$/);
        if (m2) { c = { hash: m2[1], ct: Number(m2[2]), subject: m2[3] }; laterCommits.push(c); }
      }
      for (const L of laterCommits) {
        if (/revert/i.test(L.subject) || (branchMatch && new RegExp('revert.*' + branchMatch[1], 'i').test(L.subject))) { revertedBy = L; break; }
      }
      if (!revertedBy) {
        // Overwrite approximation: compare lines added by M in F against current HEAD content of F
        try {
          const showDiff = git(['show', '-M', '--format=', '--unified=0', M.hash, '--', F]);
          const added = [];
          for (const line of showDiff.split(/\r?\n/)) {
            if (line.startsWith('+') && !line.startsWith('+++')) { const t = line.slice(1).trim(); if (t) added.push(t); }
          }
          if (added.length) {
            let headContent = '';
            try { headContent = git(['show', `HEAD:${F}`]); } catch (_) { headContent = ''; }
            const headLines = new Set(headContent.split(/\r?\n/).map(l => l.trim()));
            const surviving = added.filter(l => headLines.has(l)).length;
            const churn = 1 - surviving / added.length;
            if (churn > 0.7) overwritten = true;
            perFile.push({ file: F, merge: M.hash.slice(0, 10), addedLines: added.length, survivingLines: surviving, survived: !overwritten });
            if (overwritten && laterCommits.length) {
              // approximate days-to-overwrite as time until last known modification of F
              const lastTouch = laterCommits[0];
              daysToOverwrite.push((lastTouch.ct - M.ct) / 86400);
            }
          }
        } catch (_) { /* file unreadable at HEAD: treat as no data */ }
      } else {
        perFile.push({ file: F, merge: M.hash.slice(0, 10), survived: false, revertedBy: revertedBy.hash.slice(0, 10) });
        daysToOverwrite.push((revertedBy.ct - M.ct) / 86400);
      }
    }
  }

  const totalMerges = merges.length;
  const fileRecords = perFile;
  const survivedCount = fileRecords.filter(f => f.survived).length;
  const r = fileRecords.length ? survivedCount / fileRecords.length : null;
  const overwriteCounts = {};
  for (const f of fileRecords) if (!f.survived) overwriteCounts[f.file] = (overwriteCounts[f.file] || 0) + 1;
  const topOverwrittenFiles = Object.entries(overwriteCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([file, count]) => ({ file, count }));

  const record = {
    timestamp: new Date().toISOString(),
    windowDays,
    totalMerges,
    totalFileChanges: fileRecords.length,
    survived: survivedCount,
    r,
    medianDaysToOverwrite: median(daysToOverwrite),
    topOverwrittenFiles,
  };

  try {
    fs.mkdirSync(MEM, { recursive: true });
    fs.appendFileSync(path.join(MEM, 'retention.ndjson'), JSON.stringify(record) + '\n');
  } catch (e) {
    record.persistError = String(e.message || e);
  }
  return record;
}

function trend() {
  const p = path.join(MEM, 'retention.ndjson');
  let recs = [];
  try {
    recs = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) {}
  const last = recs[recs.length - 1] || null;
  const prev = recs[recs.length - 2] || null;
  return { last, prev, deltaR: last && prev && typeof last.r === 'number' && typeof prev.r === 'number' ? last.r - prev.r : null };
}

module.exports = { computeRetention, trend };
if (require.main === module) {
  const argDays = Number(process.argv[2]) || undefined;
  console.log(JSON.stringify(computeRetention(argDays ? { windowDays: argDays } : {}), null, 2));
}


