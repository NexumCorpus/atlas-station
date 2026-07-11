'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const turns = require('../session-log.cjs');
const { buildContext } = require('../memcontext.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-conversation-'));
turns.appendTurn('remember this decision', dir, null, 'user');
turns.appendTurn('I will act on it', dir, null, 'atlas');
turns.appendTurn('autonomy status noise', dir, null, 'autonomy');

const recent = turns.getRecentTurns(dir, 3);
assert.deepEqual(recent.map(t => t.role), ['user', 'atlas', 'autonomy']);
assert.throws(() => turns.appendTurn('bad role', dir, null, 'unknown'), /invalid role/);

const context = buildContext('next action', {
  memDir: dir, journalPath: path.join(dir, 'missing.md'), maxContextChars: 20_000,
});
assert.match(context, /Recent Direct Dialogue/);
assert.match(context, /Daniel: remember this decision/);
assert.match(context, /Atlas: I will act on it/);
assert.doesNotMatch(context, /autonomy status noise/);

console.log('conversation spine: ALL PASS');
