'use strict';
const assert = require('assert/strict');
const { legacy, validate, envelope, textAnchor, anchorMatches } = require('../circulation.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memstore = require('../memstore.cjs');
const turns = require('../session-log.cjs');
const crystals = require('../crystals.cjs');
const mutations = require('../mutationmap.cjs');
const sessions = require('../session-narrative.cjs');

assert.equal(envelope(null, 'ingress', 'test').legacy, true);
assert.throws(() => validate({ ...legacy(), completeness: { scope: 'source', read_bytes: 1, unread_bytes: 1, status: 'complete' } }), /unread/);
assert.throws(() => validate({ ...legacy('memory-write'), confidence: 'verified', stage: 'memory-write' }), /falsifier/);
assert.doesNotThrow(() => validate({ ...legacy('memory-write'), confidence: 'verified', stage: 'memory-write', falsifiers: [{ status: 'pass', ref: 'test:x' }] }));
assert.throws(() => validate({ ...legacy(), authority: { level: 'propose', human_grant: null, mutation_allowed: true } }), /write/);
assert.equal(anchorMatches('raw bytes', textAnchor('raw bytes')), true);
assert.equal(anchorMatches('stale bytes', textAnchor('raw bytes')), false);
const binary = Buffer.from([0, 255, 1, 254]);
assert.equal(anchorMatches(binary, textAnchor(binary)), true);
assert.notEqual(textAnchor(binary), textAnchor(String(binary)), 'binary anchors must hash bytes, not String coercion');
assert.throws(() => validate({ ...legacy('memory-write'), organism: true }), /executing provider/);
assert.doesNotThrow(() => validate({ ...legacy('memory-write'), organism: true,
  execution: { provider: 'codex-cli', model: 'gpt-5.6-luna', route: 'orchestrator-required-directive' } }));

const recursive = { ...legacy('memory-write', 'test'), flow_id: 'recursive-1', legacy: false,
  organism: true, confidence: 'inferred',
  execution: { provider: 'codex-cli', model: 'gpt-5.6-luna', route: 'orchestrator-required-directive' },
  provenance: [{ kind: 'model-output-utf8', sha256: textAnchor('observed') }],
  completeness: { scope: 'selected', read_bytes: 8, unread_bytes: 0, status: 'complete' },
  admission: { stale_status: 'fresh', falsifier_ref: 'holdout-1', selector: 'independent-holdout' },
  falsifiers: [{ ref: 'holdout-1', status: 'pending', independent: true }] };
assert.doesNotThrow(() => validate(recursive), 'inferred pending receipt is retained');
for (const [name, change] of [
  ['self-confirming selector', { admission: { ...recursive.admission, selector: 'source-self-confirmation' } }],
  ['stale source', { admission: { ...recursive.admission, stale_status: 'stale' } }],
  ['partial context', { completeness: { ...recursive.completeness, unread_bytes: 3, status: 'partial' } }],
  ['wrong model', { execution: { ...recursive.execution, model: 'gpt-5.6-terra' } }],
  ['non-independent falsifier', { falsifiers: [{ ref: 'holdout-1', status: 'pending', independent: false }] }],
]) assert.throws(() => validate({ ...recursive, ...change }), /organism|complete selected|independent|fresh|Luna/,
  `hostile case rejected: ${name}`);
assert.throws(() => validate({ ...recursive, confidence: 'verified', falsifiers: [{ ref: 'holdout-1', status: 'fail', independent: true }] }), /passing/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-circulation-'));
const verified = { ...legacy('memory-write', 'test'), flow_id: 'flow-1', legacy: false,
  falsifiers: [{ ref: 'test:green', status: 'pass' }] };
const fact = memstore.appendFact({ topic: 'circulation', fact: 'anchored fact', source: 'test', confidence: 'verified', hermes: verified }, dir);
assert.equal(fact.hermes.flow_id, 'flow-1');
assert.throws(() => memstore.appendFact({ topic: 'bad', fact: 'bad', source: 'test', confidence: 'verified', hermes: { ...verified, falsifiers: [] } }, dir), /falsifier/);
const run = memstore.appendRun({ agentId: 'A-1', task: 'test', mode: 'read', state: 'done' }, dir);
assert.equal(run.hermes.legacy, true);
assert.throws(() => memstore.appendRun({ agentId: 'A-2', task: 'test', mode: 'deploy', state: 'done' }, dir), /mode must be/);
assert.throws(() => memstore.appendRun({ agentId: 'A-3', task: 'test', mode: 'read', state: 'pending' }, dir), /state must be/);
assert.deepEqual(memstore.recallFacts('anchored fact', { dir, maxResults: 0 }), []);
turns.appendTurn('turn', dir); assert.equal(turns.getRecentTurns(dir, 1)[0].hermes.legacy, true);
assert.equal(crystals.appendCrystal('crystal', '1', dir).hermes.stage, 'memory-write');
mutations.recordMutation('A-1', ['x.js'], dir); assert.equal(mutations.loadMutations(dir)[0].hermes.stage, 'proposal');
sessions.writeSession({ ts: '2026-01-01T00:00:00Z' }, dir); assert.equal(sessions.loadLastSession(dir).hermes.stage, 'memory-write');
console.log('circulation: ALL PASS');
