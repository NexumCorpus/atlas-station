'use strict';
// Unit tests for ingress-text.cjs — run with: node test/ingress-text.test.cjs
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyIngress, appendDirective } = require('../ingress-text.cjs');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log(`ok - ${name}`); }

t('imperative detection', () => {
  assert.strictEqual(classifyIngress('Fix the login bug').intentClass, 'build-directive');
});

t('question detection', () => {
  assert.strictEqual(classifyIngress('What does X do?').intentClass, 'question');
});

t('meta-instruction detection', () => {
  assert.strictEqual(classifyIngress('Always verify before merge').intentClass, 'meta-instruction');
});

t('continuation detection', () => {
  assert.strictEqual(classifyIngress('continue').intentClass, 'continuation');
});

t('empty-string safety', () => {
  const r = classifyIngress('');
  assert.ok(r && typeof r.intentClass === 'string');
  assert.deepStrictEqual(r.scope, { deliverables: [], constraints: [], refs: [] });
  assert.strictEqual(typeof classifyIngress(null).confidence, 'number');
});

t('result shape', () => {
  const r = classifyIngress('Fix the login bug in auth.cjs without breaking tests');
  assert.ok(Array.isArray(r.scope.deliverables));
  assert.ok(r.scope.constraints.length >= 1);
  assert.ok(r.scope.refs.includes('auth.cjs'));
  assert.ok(r.confidence > 0);
});

t('appendDirective writes sha256 record', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-'));
  const rec = appendDirective(tmp, { text: 'hello directive' });
  assert.strictEqual(rec.hash, crypto.createHash('sha256').update('hello directive').digest('hex'));
  const lines = fs.readFileSync(path.join(tmp, 'directives.ndjson'), 'utf8').trim().split('\n');
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['hash', 'text', 'ts']);
});

console.log(`${pass} tests passed`);
process.exit(0);
