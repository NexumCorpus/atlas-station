'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'v1.contract.json');
const RECEIPT_PATH = path.join(ROOT, '.atlas', 'v1-readiness.json');
const args = new Set(process.argv.slice(2));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Same rule as fleethost.mjs: .env and .env.local in the repository root are the
// operator-owned config and override inherited environment variables.
function withDotEnv(base) {
  const merged = { ...base };
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      merged[match[1]] = value;
    }
  }
  return merged;
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

  // The executive route is whatever the fleet sidecar would actually run: the
  // same ATLAS_PROVIDER / .env resolution as fleethost.mjs, restricted to the
  // routes the contract supports. Codex and Claude worker routes are disabled.
  const env = args.has('--no-dotenv') ? { ...process.env } : withDotEnv(process.env);
  const requestedRoute = String(env.ATLAS_PROVIDER || contract.inference.defaultRoute).toLowerCase();
  const routeSupported = contract.inference.supportedRoutes.includes(requestedRoute)
    && !contract.inference.disabledRoutes.includes(requestedRoute);
  checks.push(check('executive-route', routeSupported, {
    requested: requestedRoute,
    supported: contract.inference.supportedRoutes,
    disabled: contract.inference.disabledRoutes,
  }));

  let provider = null;
  let assignment = null;
  let providerProbe = null;
  if (routeSupported) {
    const providerModule = await import(pathToFileURL(path.join(ROOT, 'providers', 'openrouter.mjs')).href);
    provider = providerModule.createOpenRouterProvider({ env });
    assignment = provider.assign();
    providerProbe = provider.probe();
  }
  checks.push(check('model-assigned', Boolean(assignment && assignment.model), assignment || 'no supported route selected'));
  // "Configured" means a credential is present, or the route is a local one that needs none.
  // It does not call the provider, so it cannot say the endpoint is reachable.
  checks.push(check('provider-configured', providerProbe && providerProbe.available, providerProbe || 'no supported route selected'));

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  checks.push(check(
    'operator-doc-truth',
    readme.includes('Hermes') && readme.includes('OpenRouter') && !readme.includes('Current status (MVP)'),
    'README must describe the current Hermes route rather than the legacy MVP'
  ));

  const commands = [];
  if (args.has('--full')) {
    commands.push(run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:full']));
  }
  if (args.has('--organism')) {
    // The rehearsal lives in the separate NexumCorpus/station repository.
    const stationCli = env.STATION_CLI || 'E:\\station\\station.py';
    const python = env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    if (fs.existsSync(stationCli)) {
      commands.push(run(python, [stationCli, 'organism', 'run'], { timeout: 10 * 60 * 1000 }));
    } else {
      commands.push({
        ok: false,
        command: [python, stationCli, 'organism', 'run'].join(' '),
        status: null,
        durationMs: 0,
        outputTail: '',
        error: `Station CLI not found at ${stationCli}. Clone NexumCorpus/station and set STATION_CLI to its station.py.`,
      });
    }
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
    provider: { name: provider ? provider.name : requestedRoute, probe: providerProbe, assignment },
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
