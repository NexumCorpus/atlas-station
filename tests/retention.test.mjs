'use strict';
// Smoke test: retention ndjson append + report math.
// Fixture: 3 merges, 1 regressed => r = 0.667
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { appendRetentionRecord, readRetentionEvents, computeRetention } = require('../retention.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
try {
  // --- ndjson append ---
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const day = 86400 * 1000;
  appendRetentionRecord(tmp, { ts: iso(3 * day), agentId: 'B-T1', mergeCommit: 'hash1', verdict: 'survived' });
  appendRetentionRecord(tmp, { ts: iso(2 * day), agentId: 'B-T2', mergeCommit: 'hash2', verdict: 'regressed' });
  appendRetentionRecord(tmp, { ts: iso(1 * day), agentId: 'B-T3', mergeCommit: 'hash3', verdict: 'survived' });
  assert.equal(readRetentionEvents(tmp).length, 3);
  const raw = fs.readFileSync(path.join(tmp, '.atlas', 'retention.ndjson'), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.ok(l.ts && typeof l.ts === 'string');
    assert.ok(['survived', 'regressed', 'unknown'].includes(l.verdict));
    assert.ok('mergeCommit' in l);
  }

  // --- report math ---
  const merges = [
    { hash: 'hash1', ts: Math.floor((now - 3 * day) / 1000) },
    { hash: 'hash2', ts: Math.floor((now - 2 * day) / 1000) },
    { hash: 'hash3', ts: Math.floor((now - 1 * day) / 1000) },
  ];
  const report = computeRetention(merges, { windowDays: 14, events: readRetentionEvents(tmp), outcomes: [] });
  assert.equal(report.merges, 3);
  assert.equal(report.survived, 2);
  assert.equal(report.regressed, 1);
  assert.equal(report.unknown, 0);
  assert.ok(Math.abs(report.r - 0.667) < 0.001, `r=${report.r}`);

  // window filter: merges older than the window are excluded
  const oldMerge = [{ hash: 'hash4', ts: Math.floor((now - 30 * day) / 1000) }];
  const r2 = computeRetention(oldMerge, { windowDays: 14, events: [], outcomes: [] });
  assert.equal(r2.merges, 0);
  assert.equal(r2.r, null);

  // corrupt line tolerated
  fs.appendFileSync(path.join(tmp, '.atlas', 'retention.ndjson'), '{broken\n');
  assert.equal(readRetentionEvents(tmp).length, 3);

  console.log('retention.test.mjs: PASS (3 merges, 1 regressed => r=0.667)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
