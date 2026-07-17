'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'v1.contract.json');
const RECEIPT_PATH = path.join(ROOT, 'release', 'v1-readiness.json');
const args = new Set(process.argv.slice(2));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(command, commandArgs, options = {}) {
  const started = Date.now();
  const useCmdShim = process.platform === 'win32' && /\.cmd$/i.test(command);
  const executable = useCmdShim ? 'cmd.exe' : command;
  const executableArgs = useCmdShim
    ? ['/d', '/s', '/c', [command, ...commandArgs].join(' ')]
    : commandArgs;
  const result = spawnSync(executable, executableArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 20 * 60 * 1000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    ok: !result.error && result.status === 0,
    command: [command, ...commandArgs].join(' '),
    status: result.status,
    durationMs: Date.now() - started,
    outputTail: output.slice(-4000),
    error: result.error ? result.error.message : null,
  };
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

async function main() {
  const contract = readJson(CONTRACT_PATH);
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const checks = [];

  checks.push(check('contract-id', contract.id === 'atlas-hermes-v1', contract.id));
  checks.push(check('package-version', pkg.version === contract.version, pkg.version));
  checks.push(check(
    'required-scripts',
    contract.requiredScripts.every((name) => typeof pkg.scripts?.[name] === 'string'),
    contract.requiredScripts.filter((name) => typeof pkg.scripts?.[name] !== 'string')
  ));
  checks.push(check(
    'required-files',
    contract.requiredFiles.every((name) => fs.existsSync(path.join(ROOT, name))),
    contract.requiredFiles.filter((name) => !fs.existsSync(path.join(ROOT, name)))
  ));

  const providerModule = await import(pathToFileURL(path.join(ROOT, 'providers', 'codex-cli.mjs')).href);
  const assignment = providerModule.resolveCodexModel({ atlasPurpose: 'orchestrator' }, {});
  const provider = providerModule.createCodexCliProvider();
  const providerProbe = provider.probe();
  checks.push(check(
    'orchestrator-route',
    assignment.model === contract.inference.orchestratorModel && assignment.purpose === 'orchestrator',
    assignment
  ));
  checks.push(check('codex-cli', providerProbe.available, providerProbe));

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  checks.push(check(
    'operator-doc-truth',
    readme.includes('Hermes') && readme.includes('gpt-5.6-luna') && !readme.includes('Current status (MVP)'),
    'README must describe current Hermes/Codex v1 rather than the legacy MVP'
  ));

  const commands = [];
  if (args.has('--full')) {
    commands.push(run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:full']));
  }
  if (args.has('--organism')) {
    commands.push(run(
      process.env.PYTHON_BIN || 'python',
      ['E:\\station\\station.py', 'organism', 'run'],
      { timeout: 10 * 60 * 1000 }
    ));
  }

  const gitStatus = run('git', ['status', '--porcelain'], { timeout: 30_000 });
  const dirty = Boolean(gitStatus.outputTail.trim());
  if (args.has('--release')) {
    checks.push(check('clean-tree', gitStatus.ok && !dirty, gitStatus.outputTail || 'clean'));
    checks.push(check('full-acceptance-executed', args.has('--full'), '--full'));
    checks.push(check('organism-rehearsal-executed', args.has('--organism'), '--organism'));
  }

  for (const command of commands) {
    checks.push(check(`command:${command.command}`, command.ok, {
      status: command.status,
      durationMs: command.durationMs,
      outputTail: command.outputTail,
      error: command.error,
    }));
  }

  const receipt = {
    schema: 1,
    contract: contract.id,
    version: contract.version,
    checkedAt: new Date().toISOString(),
    status: checks.every((item) => item.ok) ? 'ready' : 'not-ready',
    sourceHead: run('git', ['rev-parse', 'HEAD'], { timeout: 30_000 }).outputTail.trim(),
    dirty,
    provider: { name: provider.name, probe: providerProbe, assignment },
    checks,
  };

  if (args.has('--write')) {
    fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
    fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== 'ready') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`v1 readiness failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
