'use strict';

const path = require('path');
const { runSweep } = require('./work-eater-run.cjs');
const { runCompiler } = require('./obligation-compiler-run.cjs');
const { searchSource } = require('../source-sight.cjs');

const handlers = Object.freeze({
  abolish_work(input) {
    return runSweep({ repo: path.join(__dirname, '..'), limit: input.limit, dryRun: input.dryRun, actor: 'ATLAS/Hermes' });
  },
  compile_obligations(input) {
    return runCompiler({ repo: path.join(__dirname, '..'), secMesa: input.secMesa, diagnostic: input.diagnostic, inputPath: input.inputPath });
  },
  inspect_source(input) {
    return searchSource({ root: path.join(__dirname, '..'), query: input.query, scope: input.scope, limit: input.limit });
  },
});

function parse(name, argv) {
  const input = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') input.dryRun = true;
    else if (arg.startsWith('--limit=')) input.limit = Number(arg.slice(8));
    else if (arg === '--sec-mesa') input.secMesa = true;
    else if (arg === '--diagnostic') input.diagnostic = true;
    else if (arg.startsWith('--input=')) input.inputPath = arg.slice(8);
    else if (arg.startsWith('--query=')) input.query = arg.slice(8);
    else if (arg.startsWith('--path=')) input.scope = arg.slice(7);
    else throw new Error(`unknown Atlas tool argument: ${arg}`);
  }
  if (name === 'abolish_work') {
    if (input.secMesa || input.diagnostic || input.inputPath) throw new Error('abolish_work does not accept obligation inputs');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8)) throw new Error('limit must be an integer from 1 through 8');
  } else if (name === 'compile_obligations') {
    if (input.dryRun || input.limit !== undefined) throw new Error('compile_obligations is pure and does not accept work-eater arguments');
    if ([input.secMesa, input.diagnostic, Boolean(input.inputPath)].filter(Boolean).length !== 1) throw new Error('compile_obligations requires exactly one of --sec-mesa, --diagnostic, or --input=<json-path>');
  } else {
    if (input.dryRun || input.secMesa || input.diagnostic || input.inputPath) throw new Error('inspect_source accepts only --query, --path, and --limit');
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
}

main().catch((error) => {
  process.stderr.write(`ATLAS TOOL FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
