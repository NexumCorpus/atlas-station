'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'v1-readiness.cjs'), 'utf8');
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

assert(source.includes("path.join(ROOT, '.atlas', 'v1-readiness.json')"),
  'readiness receipt must live on the ignored runtime surface');
assert(!source.includes(':!release/v1-readiness.json'),
  'clean-tree gate must not hide a tracked receipt mutation');
assert(source.includes("run('git', ['status', '--porcelain']"),
  'release gate must inspect the complete source worktree');
assert(ignore.split(/\r?\n/).includes('.atlas/v1-readiness.json'),
  'runtime receipt must be explicitly ignored');
assert(readme.includes('`.atlas/v1-readiness.json`'),
  'operator documentation must name the truthful runtime receipt');
assert(!fs.existsSync(path.join(root, 'release', 'v1-readiness.json')),
  'tracked self-referential receipt must be retired');

// Behaviour: the gate judges the route the sidecar would actually run. It must
// pass for a supported route, fail for an unconfigured or disabled one, and
// report a missing Station checkout by name instead of failing obscurely.
const { spawnSync } = require('child_process');
function readiness(extraEnv, extraArgs = []) {
  const env = { ...process.env, ...extraEnv };
  delete env.OPENROUTER_API_KEY;
  Object.assign(env, extraEnv);
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'v1-readiness.cjs'), '--no-dotenv', ...extraArgs], { cwd: root, encoding: 'utf8', env });
  const receipt = JSON.parse(run.stdout);
  const failed = receipt.checks.filter((item) => !item.ok).map((item) => item.name);
  return { status: run.status, receipt, failed };
}

const local = readiness({ ATLAS_PROVIDER: 'ollama' });
assert.equal(local.status, 0, `ollama route must be ready, failed: ${local.failed}`);
assert.equal(local.receipt.status, 'ready');

const unconfigured = readiness({ ATLAS_PROVIDER: 'openrouter' });
assert.deepEqual(unconfigured.failed, ['provider-configured'], 'default route without a key fails only on configuration');
assert.equal(unconfigured.status, 1);

const configured = readiness({ ATLAS_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-value-not-a-secret' });
assert.equal(configured.status, 0, `configured default route must be ready, failed: ${configured.failed}`);

const disabled = readiness({ ATLAS_PROVIDER: 'codex-cli' });
assert.ok(disabled.failed.includes('executive-route'), 'a disabled Codex route must fail the gate');
assert.equal(disabled.status, 1);

const noStation = readiness({ ATLAS_PROVIDER: 'ollama', STATION_CLI: path.join(root, 'no-such-station.py') }, ['--organism']);
const rehearsal = noStation.receipt.checks.find((item) => item.name.startsWith('command:'));
assert.equal(rehearsal.ok, false);
assert.match(rehearsal.detail.error, /NexumCorpus\/station/, 'missing Station checkout is named in the failure');

console.log('v1 readiness receipt contract: ALL PASS');
