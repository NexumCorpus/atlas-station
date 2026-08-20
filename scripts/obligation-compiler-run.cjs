'use strict';

const fs = require('fs');
const path = require('path');
const { compile, evidenceHash } = require('../obligation-compiler.cjs');
const { runSecContractProof } = require('../sec-contract-proof.cjs');

const MAX_INPUT_BYTES = 65_536;

function diagnosticScenario() {
  const obligations = [
    { id: 'O-ASTER-BOREAL', debtor: 'ASTER', creditor: 'BOREAL', kind: 'gpu-reservation', faceCents: 150_000, avoidableFulfillmentCostCents: 48_000, source: 'hypothetical://aster/contract/compute-17' },
    { id: 'O-BOREAL-CINDER', debtor: 'BOREAL', creditor: 'CINDER', kind: 'empty-backhaul', faceCents: 140_000, avoidableFulfillmentCostCents: 38_000, source: 'hypothetical://boreal/contract/freight-22' },
    { id: 'O-CINDER-DELTA', debtor: 'CINDER', creditor: 'DELTA', kind: 'cold-storage-slot', faceCents: 145_000, avoidableFulfillmentCostCents: 42_000, source: 'hypothetical://cinder/contract/cold-08' },
    { id: 'O-DELTA-ASTER', debtor: 'DELTA', creditor: 'ASTER', kind: 'maintenance-credit', faceCents: 155_000, avoidableFulfillmentCostCents: 45_000, source: 'hypothetical://delta/contract/facility-31' },
  ].map((row) => ({ ...row, evidenceHash: evidenceHash(row) }));
  return {
    schema: 1,
    scenarioId: 'proof-cross-species-4',
    asOf: '2026-08-11T00:00:00.000Z',
    evidenceClass: 'hypothetical-operator-scenario',
    novationCostCents: 25_000,
    feeBps: 2000,
    participants: [
      { id: 'ASTER', residualToleranceCents: 15_000, consentObligationIds: ['O-ASTER-BOREAL', 'O-DELTA-ASTER'] },
      { id: 'BOREAL', residualToleranceCents: 15_000, consentObligationIds: ['O-ASTER-BOREAL', 'O-BOREAL-CINDER'] },
      { id: 'CINDER', residualToleranceCents: 15_000, consentObligationIds: ['O-BOREAL-CINDER', 'O-CINDER-DELTA'] },
      { id: 'DELTA', residualToleranceCents: 15_000, consentObligationIds: ['O-CINDER-DELTA', 'O-DELTA-ASTER'] },
    ],
    obligations,
  };
}

function loadScenario(repo, options) {
  if (options.diagnostic) return diagnosticScenario();
  if (!options.inputPath) throw new Error('compile_obligations requires --sec-mesa, --diagnostic, or --input=<json-path>');
  const root = fs.realpathSync(path.resolve(repo));
  const target = path.resolve(root, options.inputPath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('obligation input escapes repository root');
  const realTarget = fs.realpathSync(target);
  const realRelative = path.relative(root, realTarget);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('obligation input symlink escapes repository root');
  const stat = fs.statSync(realTarget);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error(`obligation input must be a file of at most ${MAX_INPUT_BYTES} bytes`);
  return JSON.parse(fs.readFileSync(realTarget, 'utf8'));
}

async function runCompiler({ repo = path.join(__dirname, '..'), secMesa = false, diagnostic = false, inputPath = null } = {}) {
  if (secMesa) return runSecContractProof();
  return compile(loadScenario(repo, { diagnostic, inputPath }));
}

function parseIngressControl(text) {
  if (typeof text !== 'string') return null;
  return /^!obligations\s+sec-mesa\s*$/i.test(text)
    ? Object.freeze({ operation: 'sec-mesa' })
    : null;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const secMesa = args.includes('--sec-mesa');
    const diagnostic = args.includes('--diagnostic');
    const inputArg = args.find((arg) => arg.startsWith('--input='));
    if (args.some((arg) => !['--sec-mesa', '--diagnostic'].includes(arg) && !arg.startsWith('--input='))) throw new Error('unknown obligation compiler argument');
    if ([secMesa, diagnostic, Boolean(inputArg)].filter(Boolean).length !== 1) throw new Error('choose exactly one of --sec-mesa, --diagnostic, or --input=<json-path>');
    process.stdout.write(`${JSON.stringify(await runCompiler({ secMesa, diagnostic, inputPath: inputArg?.slice(8) }), null, 2)}\n`);
  })().catch((error) => {
    process.stderr.write(`OBLIGATION COMPILER FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { diagnosticScenario, parseIngressControl, runCompiler };
