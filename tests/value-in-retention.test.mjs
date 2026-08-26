import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert';

const require = createRequire(import.meta.url);

test('value_claims.cjs exports valueStats', () => {
  const vc = require('../value_claims.cjs');
  assert.strictEqual(typeof vc.valueStats, 'function');
});

test('fleethost.mjs retention_report handler includes valueClaims', () => {
  const src = readFileSync(new URL('../fleethost.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('retentionReportTool = tool(');
  assert.ok(i >= 0, 'retentionReportTool found');
  const j = src.indexOf('projectCreateTool = tool(', i);
  const region = src.slice(i, j > i ? j : undefined);
  assert.ok(region.includes('valueClaims:'), 'valueClaims key in handler region');
  assert.ok(region.includes('_valueClaims.valueStats'), 'valueStats called in handler region');
  assert.ok(region.includes('realizationRate'), 'realizationRate included');
});
