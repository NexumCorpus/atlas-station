import assert from 'node:assert/strict';
import {
  buildCodexCommand,
  buildCodexPrompt,
  compatibleSession,
  normalizeCodexEvent,
  resolveCodexSandbox,
} from '../providers/codex-cli.mjs';

const env = { ATLAS_REPO: 'E:/atlas-station' };

assert.equal(resolveCodexSandbox({ atlasMode: 'read' }, env), 'read-only');
assert.equal(resolveCodexSandbox({ atlasMode: 'orchestrator' }, env), 'read-only');
assert.equal(resolveCodexSandbox({ atlasMode: 'build' }, env), 'workspace-write');
assert.equal(compatibleSession('thread-1', 'codex-cli', 'codex-cli'), 'thread-1');
assert.equal(compatibleSession('claude-session', 'claude-sdk', 'codex-cli'), null);
assert.equal(compatibleSession('legacy-session', undefined, 'codex-cli'), null);

const direct = buildCodexCommand({
  prompt: 'inspect the repository', options: { cwd: 'E:/atlas-station', atlasMode: 'build' }, env, command: 'codex',
});
assert.deepEqual(direct.args.slice(0, 3), ['exec', '--json', '--color']);
assert.ok(direct.args.includes('-C'));
assert.ok(direct.args.includes('workspace-write'));
assert.ok(direct.args.includes('--ignore-user-config'));

const resumed = buildCodexCommand({
  prompt: 'continue', options: { resume: 'thread-123', atlasMode: 'orchestrator' }, env, command: 'codex',
});
assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', '--json']);
assert.ok(resumed.args.includes('thread-123'));
assert.ok(!resumed.args.includes('-C'), 'Codex resume owns its original cwd');

const prepared = buildCodexPrompt('do the task', { atlasMode: 'read' });
assert.match(prepared, /fleet MCP tools are not attached/);
assert.match(prepared, /do the task/);
assert.match(buildCodexPrompt('task', { systemPrompt: 'keep an evidence trail' }), /keep an evidence trail/);

const state = {};
assert.deepEqual(normalizeCodexEvent({ type: 'thread.started', thread_id: 'abc' }, state), [
  { type: 'system', subtype: 'init', session_id: 'abc' },
]);
const text = normalizeCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, state);
assert.equal(text[0].message.content[0].text, 'done');
const tool = normalizeCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'git status' } }, state);
assert.equal(tool[0].message.content[0].name, 'Bash');
const result = normalizeCodexEvent({ type: 'turn.completed', usage: { output_tokens: 4 } }, state);
assert.equal(result[0].subtype, 'success');
assert.equal(result[0].result, 'done');

console.log('codex provider: ALL PASS');
