'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResponseVitals, percentile } = require('../response-vitals.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-response-vitals-'));
const vitals = createResponseVitals(root);
const id = vitals.begin({ submissionId: 's1', directiveId: 'd1', ingressAt: 1000, claimAt: 1100 });
assert(vitals.mark(id, 'providerAt', 1250));
assert(vitals.mark(id, 'firstOutputAt', 1500));
assert(vitals.mark(id, 'firstOutputAt', 9999), 'duplicate first-output marks are idempotent');
const row = vitals.settle(id, { at: 2100, state: 'done', provider: 'test', model: 'test-model' });
assert.deepEqual({ queueMs: row.queueMs, admissionMs: row.admissionMs, firstOutputMs: row.firstOutputMs, settleMs: row.settleMs },
  { queueMs: 100, admissionMs: 150, firstOutputMs: 500, settleMs: 1100 });
assert.equal(vitals.summary().firstOutputP50Ms, 500);
assert.equal(vitals.summary().active, 0);
assert.equal(percentile([10, 30, 20, 40], .95), 40);
assert.equal(vitals.settle('missing'), null);
const host = fs.readFileSync(path.join(__dirname, '..', 'fleethost.mjs'), 'utf8');
assert.match(host, /onFirstOutput\(meta\)/);
assert.match(host, /send\('response_vital', \{ record, summary: _responseVitals\.summary\(\) \}\)/);
assert.match(host, /settleResponseVital\(interrupted \? 'interrupted' : 'done'/);
const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
assert.match(main, /responseVitals: responseVitals\.summary\(50\)/, 'desktop health hydration must survive a sidecar restart');
fs.rmSync(root, { recursive: true, force: true });
console.log('response vitals: durable latency phases and percentiles PASS');
