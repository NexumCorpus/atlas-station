import assert from 'node:assert/strict';
import {
  buildCodexCommand,
  buildCodexPrompt,
  compatibleSession,
  normalizeCodexEvent,
  resolveCodexModel,
  resolveCodexSandbox,
} from '../providers/codex-cli.mjs';

const env = { ATLAS_REPO: 'E:/atlas-station' };

assert.equal(resolveCodexSandbox({ atlasMode: 'read' }, env), 'read-only');
assert.equal(resolveCodexSandbox({ atlasMode: 'orchestrator' }, env), 'read-only');
assert.equal(resolveCodexSandbox({ atlasMode: 'build' }, env), 'workspace-write');
const unrestrictedEnv = { ...env, ATLAS_CODEX_UNRESTRICTED: '1' };
assert.equal(resolveCodexSandbox({ atlasMode: 'read' }, unrestrictedEnv), 'danger-full-access');
assert.equal(compatibleSession('thread-1', 'codex-cli', 'codex-cli'), 'thread-1');
assert.equal(compatibleSession('claude-session', 'claude-sdk', 'codex-cli'), null);
assert.equal(compatibleSession('legacy-session', undefined, 'codex-cli'), null);
assert.deepEqual(
  resolveCodexModel({ atlasPurpose: 'implementation' }, env),
  { purpose: 'implementation', route: 'deep', model: 'gpt-5.6-terra', source: 'station-default' },
);
assert.deepEqual(
  resolveCodexModel({ atlasPurpose: 'crystallization' }, env),
  { purpose: 'crystallization', route: 'fast', model: 'gpt-5.5', source: 'station-default' },
);
assert.equal(
  resolveCodexModel({ atlasPurpose: 'build' }, { ...env, ATLAS_CODEX_DEEP_MODEL: 'deep-pin' }).model,
  'deep-pin',
);
assert.equal(
  resolveCodexModel({ atlasPurpose: 'research', atlasAssignedModel: 'thread-pin' }, env).source,
  'persisted',
);
assert.deepEqual(
  resolveCodexModel({ atlasPurpose: 'orchestration', atlasAssignedModel: 'gpt-5.6-terra', atlasRequiredModel: 'gpt-5.6-luna' }, env),
  { purpose: 'orchestration', route: 'deep', model: 'gpt-5.6-luna', source: 'required-directive' },
);

const direct = buildCodexCommand({
  prompt: 'inspect the repository', options: { cwd: 'E:/atlas-station', atlasMode: 'build' }, env, command: 'codex',
});
assert.deepEqual(direct.args.slice(0, 3), ['exec', '--json', '--color']);
assert.ok(direct.args.includes('-C'));
assert.ok(direct.args.includes('workspace-write'));
assert.ok(direct.args.includes('--ignore-user-config'));
assert.equal(direct.assignment.model, 'gpt-5.6-terra');

const resumed = buildCodexCommand({
  prompt: 'continue', options: { resume: 'thread-123', atlasMode: 'orchestrator' }, env, command: 'codex',
});
assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', '--json']);
assert.ok(resumed.args.includes('thread-123'));
assert.ok(!resumed.args.includes('-C'), 'Codex resume owns its original cwd');
assert.equal(resumed.assignment.model, 'gpt-5.6-terra');

const lunaFresh = buildCodexCommand({
  prompt: 'orchestrate', options: { cwd: 'E:/atlas-station', atlasMode: 'orchestrator', atlasPurpose: 'orchestration', atlasRequiredModel: 'gpt-5.6-luna' }, env, command: 'codex',
});
assert.equal(lunaFresh.assignment.model, 'gpt-5.6-luna');
assert.equal(lunaFresh.assignment.source, 'required-directive');
const lunaResumed = buildCodexCommand({
  prompt: 'resume', options: { resume: 'terra-thread', atlasMode: 'orchestrator', atlasPurpose: 'orchestration', atlasAssignedModel: 'gpt-5.6-terra', atlasRequiredModel: 'gpt-5.6-luna' }, env, command: 'codex',
});
assert.ok(lunaResumed.args.includes('gpt-5.6-luna'));
assert.ok(!lunaResumed.args.includes('gpt-5.6-terra'));
const unrestricted = buildCodexCommand({
  prompt: 'repair', options: { atlasMode: 'read' }, env: unrestrictedEnv, command: 'codex',
});
assert.ok(unrestricted.args.includes('--dangerously-bypass-approvals-and-sandbox'));
assert.ok(unrestricted.args.includes('danger-full-access'));
const unrestrictedResumed = buildCodexCommand({
  prompt: 'repair', options: { resume: 'old-read-only-thread', atlasMode: 'orchestrator' }, env: unrestrictedEnv, command: 'codex',
});
assert.deepEqual(unrestrictedResumed.args.slice(0, 2), ['exec', '--json']);
assert.ok(!unrestrictedResumed.args.includes('old-read-only-thread'));

const prepared = buildCodexPrompt('do the task', { atlasMode: 'read' });
assert.match(prepared, /fleet MCP tools are not attached/);
assert.match(prepared, /station\.py hermes ask/);
assert.match(prepared, /Hermes is the entire local organism/);
assert.match(prepared, /Station reader's output is advisory/);
assert.match(prepared, /do the task/);
assert.match(buildCodexPrompt('task', { systemPrompt: 'keep an evidence trail' }), /keep an evidence trail/);
assert.match(buildCodexPrompt('task', { atlasExecutionModel: 'gpt-5.6-luna' }), /Exact execution model for this invocation: gpt-5.6-luna/);

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
