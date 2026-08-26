'use strict';
const assert = require('assert');
const { checkReply } = require('../reply-contract.cjs');

let failed = 0;
function t(name, fn) { try { fn(); console.log('ok  -', name); } catch (e) { failed++; console.log('FAIL -', name, e.message); } }

// Rule 1: boilerplate opener rejected
t('rule1 rejects boilerplate opener', () => {
  const r = checkReply('Sure! Let me know if you need anything.\n\nSecond line.', {});
  assert.strictEqual(r.pass, false);
  assert.ok(r.violations.some(v => v.startsWith('boilerplate-opener')));
});
t('rule1 accepts substantive opener after boilerplate stem', () => {
  const r = checkReply('I implemented the parser fix in providers/openrouter.mjs:120 and verified it with node --check.', {});
  assert.strictEqual(r.pass, true);
});
t('rule1 accepts direct answer', () => {
  const r = checkReply('Build complete. All checks pass.', {});
  assert.strictEqual(r.pass, true);
});

// Rule 2: state claims need evidence
t('rule2 flags unsupported state claim', () => {
  const r = checkReply('The merge is done.', {});
  assert.strictEqual(r.pass, false);
  assert.ok(r.violations.some(v => v.startsWith('unsupported-state-claim')));
});
t('rule2 passes with file:line evidence', () => {
  const r = checkReply('The merge is done — see fleethost.mjs:4412 for the wiring.', {});
  assert.strictEqual(r.pass, true);
});
t('rule2 passes with hex hash evidence', () => {
  const r = checkReply('The fix was shipped in commit ab12cd9ef0.', {});
  assert.strictEqual(r.pass, true);
});

// Rule 3: tool mentions must be in registry
t('rule3 flags unknown tool mention', () => {
  const r = checkReply('Used the tool named phantom_tool to inspect state.', { tools: ['check_fleet', 'spawn_agent'] });
  assert.strictEqual(r.pass, false);
  assert.ok(r.violations.some(v => v.startsWith('unknown-tool-mention')));
});
t('rule3 passes known tool mention', () => {
  const r = checkReply('Ran the tool named check_fleet to list agents.', { tools: ['check_fleet'] });
  assert.strictEqual(r.pass, true);
});
t('rule3 skips registry check when no registry provided', () => {
  const r = checkReply('Used the tool named anything_at_all.', {});
  assert.strictEqual(r.pass, true);
});

// Rule 4: handoff at most once
t('rule4 flags repeated handoff', () => {
  const r = checkReply('Will continue next turn. Then will continue again next turn.', {});
  assert.strictEqual(r.pass, false);
  assert.ok(r.violations.some(v => v.startsWith('handoff-repetition')));
});
t('rule4 allows one handoff', () => {
  const r = checkReply('Partial result delivered; will continue next turn.', {});
  assert.strictEqual(r.pass, true);
});

// Clean reply
t('clean reply passes with all context', () => {
  const r = checkReply(
    'Build complete and verified: reply-contract.cjs:10 wired into fleethost.mjs:4644; tests pass (commit ab12cd9ef0).',
    { tools: ['check_fleet'] }
  );
  assert.deepStrictEqual(r.violations, []);
  assert.strictEqual(r.pass, true);
});

if (failed) { console.log(failed + ' test(s) FAILED'); process.exit(1); }
console.log('ALL PASS');
