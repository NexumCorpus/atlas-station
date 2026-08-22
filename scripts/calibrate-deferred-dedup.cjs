#!/usr/bin/env node
'use strict';
// Calibration harness for the deferred-task dedup guard (deferred.cjs).
// Replays the real retired duplicate corpus through the SHIPPED module and
// reports recall. Run this BEFORE changing CLUSTER_SHARED_STEMS or
// FUZZY_MIN_TOKENS, and after: thresholds must be recalibrated against
// measurement, never intuition.
// Shipped operating point at time of writing: recall 10/17, FP 0/19.
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.join(__dirname, '..');
const d = require(path.join(REPO, 'deferred.cjs'));
const livePath = path.join(REPO, 'memory', 'deferred.ndjson');
const fam = fs.readFileSync(livePath, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(JSON.parse).filter(o => o.state === 'retired').map(o => o.task);
if (!fam.length) { console.log('no retired corpus found - nothing to calibrate'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-calibration-'));
try {
  let supp = 0;
  fam.forEach((t, i) => {
    const r = d.deferTask(t, {
      blocker: 'Calibration replay ' + i + ' of the historical duplicate family',
      nextAction: 'Replay the retired phrasing through the shipped guard',
      validationCondition: 'Recall matches the documented operating point',
    }, tmp);
    if (r.__suppressed) supp++;
  });
  console.log('corpus recall:', supp + '/' + fam.length);
  process.exit(0);
} finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
