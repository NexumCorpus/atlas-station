'use strict';

const fs = require('fs');
const path = require('path');
const { runSweep } = require('./work-eater-run.cjs');
const { runCompiler } = require('./obligation-compiler-run.cjs');
const { searchSource } = require('../source-sight.cjs');
const { compileClaim } = require('../claim-compiler.cjs');
const { runRfc8259Proof, inspectGauntlet, supersedeGauntlet } = require('../gauntlet.cjs');
const skillCapsule = require('../skill-capsule.cjs');
const skillFitness = require('../skill-fitness.cjs');
const skillEvolution = require('../skill-evolution.cjs');
const { scanPaidProblems } = require('../paid-problem-radar.cjs');

const REPO = path.join(__dirname, '..');
function repoInput(inputPath) {
  const resolved = path.resolve(inputPath);
  const relative = path.relative(REPO, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('input path escapes Atlas repository');
  return resolved;
}

const handlers = Object.freeze({
  abolish_work(input) {
    return runSweep({ repo: path.join(__dirname, '..'), limit: input.limit, dryRun: input.dryRun, actor: 'ATLAS/Hermes' });
  },
  compile_obligations(input) {
    return runCompiler({ repo: path.join(__dirname, '..'), secMesa: input.secMesa, diagnostic: input.diagnostic, inputPath: input.inputPath });
  },
  compile_claim(input) {
    return compileClaim(fs.readFileSync(path.resolve(input.inputPath)));
  },
  gauntlet_rfc8259(input) {
    return runRfc8259Proof({ ledgerPath: input.ledgerPath, liveBeacon: input.liveBeacon, trialCount: input.limit });
  },
  gauntlet_inspect(input) {
    return inspectGauntlet(input.ledgerPath);
  },
  gauntlet_supersede(input) {
    return supersedeGauntlet({
      ledgerPath: input.ledgerPath,
      settlementHash: input.settlementHash,
      counterexample: JSON.parse(fs.readFileSync(repoInput(input.inputPath), 'utf8')),
    });
  },
  skill_index() {
    const library = skillCapsule.index();
    return { indexHash: library.indexHash, skills: library.skills.map(({ folder, ...skill }) => skill) };
  },
  skill_select(input) {
    const receipt = skillCapsule.select(input.query, { limit: input.limit, tokenBudget: input.tokenBudget });
    const ledger = skillFitness.recordSelection(receipt);
    return { ...receipt, ledgerHash: ledger.recordHash };
  },
  skill_fitness() {
    return skillFitness.project();
  },
  skill_outcome(input) {
    return skillFitness.recordOutcome(JSON.parse(fs.readFileSync(repoInput(input.inputPath), 'utf8')));
  },
  skill_stage(input) {
    return skillEvolution.stageVariant(JSON.parse(fs.readFileSync(repoInput(input.inputPath), 'utf8')));
  },
  skill_admit(input) {
    return skillEvolution.admitVariant(JSON.parse(fs.readFileSync(repoInput(input.inputPath), 'utf8')));
  },
  inspect_source(input) {
    return searchSource({ root: path.join(__dirname, '..'), query: input.query, scope: input.scope, limit: input.limit });
  },
  economic_radar(input) {
    return scanPaidProblems({
      sources: input.sources?.length ? input.sources : undefined,
      minUsd: input.minUsd,
      targetWeeklyUsd: input.targetWeeklyUsd,
      limit: input.limit,
      capabilities: input.capabilities?.length ? input.capabilities : undefined,
    });
  },
});

function parse(name, argv) {
  const allowed = {
    abolish_work: ['--dry-run', '--limit'], compile_obligations: ['--sec-mesa', '--diagnostic', '--input'], compile_claim: ['--input'],
    gauntlet_rfc8259: ['--diagnostic', '--live-beacon', '--limit', '--ledger'], gauntlet_inspect: ['--ledger'], gauntlet_supersede: ['--input', '--settlement', '--ledger'],
    skill_index: [], skill_select: ['--query', '--limit', '--token-budget'], skill_fitness: [], skill_outcome: ['--input'], skill_stage: ['--input'], skill_admit: ['--input'],
    inspect_source: ['--query', '--path', '--limit'], economic_radar: ['--source', '--min-usd', '--target-weekly-usd', '--limit', '--capability'],
  }[name];
  if (!allowed) throw new Error(`unknown Atlas tool: ${name}`);
  for (const arg of argv) {
    const key = arg.split('=', 1)[0];
    if (!allowed.includes(key)) throw new Error(`${name} does not accept ${key}`);
  }
  const input = { dryRun: false, liveBeacon: false, sources: [], capabilities: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') input.dryRun = true;
    else if (arg.startsWith('--limit=')) input.limit = Number(arg.slice(8));
    else if (arg === '--sec-mesa') input.secMesa = true;
    else if (arg === '--diagnostic') input.diagnostic = true;
    else if (arg === '--live-beacon') input.liveBeacon = true;
    else if (arg.startsWith('--input=')) input.inputPath = arg.slice(8);
    else if (arg.startsWith('--ledger=')) input.ledgerPath = repoInput(arg.slice(9));
    else if (arg.startsWith('--settlement=')) input.settlementHash = arg.slice(13);
    else if (arg.startsWith('--query=')) input.query = arg.slice(8);
    else if (arg.startsWith('--token-budget=')) input.tokenBudget = Number(arg.slice(15));
    else if (arg.startsWith('--path=')) input.scope = arg.slice(7);
    else if (arg.startsWith('--source=')) input.sources.push(arg.slice(9));
    else if (arg.startsWith('--min-usd=')) input.minUsd = Number(arg.slice(10));
    else if (arg.startsWith('--target-weekly-usd=')) input.targetWeeklyUsd = Number(arg.slice(20));
    else if (arg.startsWith('--capability=')) input.capabilities.push(arg.slice(13));
    else throw new Error(`unknown Atlas tool argument: ${arg}`);
  }
  if (name === 'abolish_work') {
    if (input.secMesa || input.diagnostic || input.inputPath) throw new Error('abolish_work does not accept obligation inputs');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8)) throw new Error('limit must be an integer from 1 through 8');
  } else if (name === 'compile_obligations') {
    if (input.dryRun || input.limit !== undefined) throw new Error('compile_obligations is pure and does not accept work-eater arguments');
    if ([input.secMesa, input.diagnostic, Boolean(input.inputPath)].filter(Boolean).length !== 1) throw new Error('compile_obligations requires exactly one of --sec-mesa, --diagnostic, or --input=<json-path>');
  } else if (name === 'compile_claim') {
    if (input.dryRun || input.limit !== undefined || input.secMesa || input.diagnostic || !input.inputPath) throw new Error('compile_claim requires exactly --input=<json-path>');
  } else if (name === 'gauntlet_rfc8259') {
    if (input.dryRun || input.secMesa || input.inputPath || Boolean(input.diagnostic) === Boolean(input.liveBeacon)) throw new Error('gauntlet_rfc8259 requires exactly one of --diagnostic or --live-beacon');
    if (input.limit === undefined) input.limit = 16;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new Error('GAUNTLET limit must be 1 through 64');
  } else if (name === 'gauntlet_inspect') {
    if (input.dryRun || input.secMesa || input.diagnostic || input.liveBeacon || input.inputPath || input.limit !== undefined) throw new Error('gauntlet_inspect accepts only --ledger=<path>');
  } else if (name === 'gauntlet_supersede') {
    if (input.dryRun || input.secMesa || input.diagnostic || input.liveBeacon || input.limit !== undefined || !input.inputPath || !input.settlementHash) throw new Error('gauntlet_supersede requires --input=<counterexample.json> and --settlement=<hash>');
  } else if (name === 'skill_index' || name === 'skill_fitness') {
    if (argv.length) throw new Error(`${name} accepts no arguments`);
  } else if (name === 'skill_select') {
    if (!input.query || input.dryRun || input.secMesa || input.diagnostic || input.liveBeacon || input.inputPath) throw new Error('skill_select requires --query=<task>');
    if (input.limit === undefined) input.limit = 5;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8) throw new Error('skill selection limit must be 1 through 8');
    if (input.tokenBudget !== undefined && (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 100 || input.tokenBudget > 8000)) throw new Error('token budget must be 100 through 8000');
  } else if (['skill_outcome', 'skill_stage', 'skill_admit'].includes(name)) {
    if (!input.inputPath || input.dryRun || input.secMesa || input.diagnostic || input.liveBeacon || input.query || input.limit !== undefined || input.tokenBudget !== undefined) throw new Error(`${name} requires exactly --input=<json-path>`);
  } else if (name === 'economic_radar') {
    if (input.dryRun || input.secMesa || input.diagnostic || input.liveBeacon || input.inputPath || input.query || input.scope || input.tokenBudget !== undefined) throw new Error('economic_radar accepts only --source, --min-usd, --target-weekly-usd, --limit, and --capability');
    if (input.sources.length > 8) throw new Error('economic_radar accepts at most 8 sources');
    if (input.capabilities.length > 24) throw new Error('economic_radar accepts at most 24 capabilities');
    if (input.limit === undefined) input.limit = 20;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new Error('economic_radar limit must be 1 through 20');
    if (input.minUsd !== undefined && (!Number.isInteger(input.minUsd) || input.minUsd < 25 || input.minUsd > 100000)) throw new Error('economic_radar min-usd must be an integer from 25 through 100000');
    if (input.targetWeeklyUsd !== undefined && (!Number.isInteger(input.targetWeeklyUsd) || input.targetWeeklyUsd < 25 || input.targetWeeklyUsd > 100000)) throw new Error('economic_radar target-weekly-usd must be an integer from 25 through 100000');
  } else {
    if (input.dryRun || input.secMesa || input.diagnostic || input.inputPath || input.tokenBudget !== undefined) throw new Error('inspect_source accepts only --query, --path, and --limit');
    if (!input.query) throw new Error('inspect_source requires --query=<text>');
    if (input.limit === undefined) input.limit = 20;
  }
  return input;
}

async function main() {
  const name = process.argv[2];
  if (!Object.hasOwn(handlers, name)) throw new Error(`unknown Atlas tool: ${name || '(empty)'}; available: ${Object.keys(handlers).join(', ')}`);
  const result = await handlers[name](parse(name, process.argv.slice(3)));
  process.stdout.write(`${JSON.stringify({ schema: 1, tool: name, ok: true, result }, null, 2)}\n`);
  if (name === 'compile_claim' && result.verdict !== 'admitted') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`ATLAS TOOL FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
