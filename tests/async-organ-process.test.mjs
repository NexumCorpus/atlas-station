import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../fleethost.mjs', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end after ${start}: ${end}`);
  return source.slice(from, to);
}

const helper = section('function runBoundedChild(', 'function extractToolArg(');
assert.match(helper, /spawnChild\(/, 'bounded child helper must use asynchronous spawn');
assert.match(helper, /signal\?\.addEventListener\('abort'/, 'bounded child helper must honor AbortSignal');
assert.match(helper, /taskkill\.exe[\s\S]*\/T[\s\S]*\/F/, 'Windows cancellation must terminate the process tree');
assert.match(helper, /killer\.once\('close',[\s\S]*confirmTreeTermination/, 'Windows cancellation must await taskkill completion');
assert.match(helper, /pidAlive\(child\.pid\)/, 'bounded child cancellation must verify root-process exit');
assert.match(helper, /terminationConfirmed/, 'unconfirmed process-tree termination must be explicit');
assert.match(helper, /setTimeout\(\(\) => terminateTree\('timeout'\)/, 'bounded child helper must enforce a timeout');
assert.match(helper, /maxOutputBytes/, 'bounded child helper must cap stdout/stderr');

for (const [start, end] of [
  ['const memConsolidateTool', 'const webResearchTool'],
  ['const webResearchTool', 'const relateFactsTool'],
  ['const fanResearchTool', 'const signalPropagateTool'],
  ['const runVariantTool', 'const fleetSdkTools'],
]) {
  const body = section(start, end);
  assert.match(body, /\{ signal \}/, `${start} must accept provider cancellation context`);
  assert.match(body, /throwIfAborted\(signal\)/, `${start} must propagate parent cancellation`);
}

const organs = [
  ['const runScriptTool', 'const memConsolidateTool'],
  ['const verifyBuildTool', 'const runTestsTool'],
  ['const runTestsTool', 'const validateFactsTool'],
  ['const shardMemoryTool', 'const recoverShardTool'],
  ['const recoverShardTool', 'const continuityStatusTool'],
  ['const stagedVerifyTool', 'const mutationMapTool'],
  ['const daemonHealthTool', 'const closeProposalTool'],
];

for (const [start, end] of organs) {
  const body = section(start, end);
  assert.doesNotMatch(body, /\b(?:spawnSync|execSync|execFileSync)\b/, `${start} must not block the sidecar event loop`);
  assert.match(body, /runBoundedChild\(/, `${start} must use the bounded async child helper`);
  assert.match(body, /\{ signal \}/, `${start} must accept provider cancellation context`);
}

const cancelHandler = section('else if (m.t === "cancel")', "else if (m.t === 'shutdown')");
assert.doesNotMatch(cancelHandler, /\bset\(/, 'IPC cancellation must not publish a duplicate terminal state');

console.log('async organ process contract: PASS');
