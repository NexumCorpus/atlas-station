'use strict';

const path = require('path');
const { WorkEater } = require('../work-eater.cjs');
const { linkRecovery } = require('../work-eater-store.cjs');
const { collectEvidence } = require('../work-eater-evidence.cjs');
const { XenobioticEcology } = require('../xenobiotic-ecology.cjs');
const mycelium = require('../context-mycelium.cjs');
const circulation = require('../circulation.cjs');
const { appendCrystal, loadCrystals } = require('../crystals.cjs');

function tissueFor(contracts, evidence) {
  const wanted = new Set(contracts.flatMap(contract => contract.evidenceRefs.map(ref => ref.evidenceId)));
  const rows = evidence.filter(item => wanted.has(item.evidenceId)).map(item => ({ evidenceId: item.evidenceId, source: item.source, line: item.line, rawHash: item.rawHash, raw: item.raw }));
  return contracts.map(contract => [
    `[Abolition contract ${contract.contractHash}]`,
    JSON.stringify({ contract, evidence: rows.filter(row => contract.evidenceRefs.some(ref => ref.evidenceId === row.evidenceId)) }),
  ].join('\n')).join('\n\n');
}

function publicContract(contract) {
  return {
    contractHash: contract.contractHash,
    signature: contract.signature,
    objective: contract.objective,
    score: contract.score,
    scoreComponents: contract.scoreComponents,
    baselineOccurrences: contract.baselineOccurrences,
    evidenceRoot: contract.evidenceRoot,
    sources: contract.sources,
    authority: contract.authority,
    counterfactualWitness: contract.counterfactualWitness,
    killCondition: contract.killCondition,
  };
}

function runSweep(options = {}) {
  const started = process.hrtime.bigint();
  const repo = path.resolve(options.repo || path.join(__dirname, '..'));
  const memDir = path.join(repo, 'memory');
  const engine = new WorkEater({ memDir, actor: options.actor || 'ATLAS/Hermes' });
  const evidence = collectEvidence(memDir);
  const sweep = engine.sweep(evidence, { limit: options.limit, dryRun: options.dryRun });
  const ecology = new XenobioticEcology({ memDir, actor: options.actor || 'ATLAS/Hermes' });
  const links = [];

  if (!options.dryRun) {
    for (const item of sweep.created) {
      const contract = item.contract;
      const recruited = ecology.recruit({ proposals: [{
        statement: contract.objective,
        description: contract.objective,
        kind: 'abolition-contract',
        niche: `work-eater:${contract.signature}`,
        impact: Math.min(1, contract.score / 500),
        evidenceRefs: contract.evidenceRefs.map(ref => ref.rawHash),
      }] });
      const linked = engine.linkEcology(contract.contractHash, {
        cellIds: recruited.cells.map(cell => cell.cellId),
        gradientIds: recruited.gradients.map(gradient => gradient.gradientId),
        ecologyHead: ecology.verifyLedger().head,
      });
      links.push({ contractHash: contract.contractHash, recordHash: linked.recordHash, cellIds: recruited.cells.map(cell => cell.cellId) });
    }
  }

  const recoveryRows = options.dryRun ? [] : engine.records().filter(row => row.kind === 'recovery-linked');
  const recoveryByContract = new Map(recoveryRows.map(row => [row.payload.contractHash, row.payload.recovery]));
  const unfinished = sweep.contracts.filter(contract => !recoveryByContract.has(contract.contractHash));
  let recovery = sweep.contracts.length ? recoveryByContract.get(sweep.contracts[0].contractHash) || recoveryRows.at(-1)?.payload.recovery || null : null;
  if (unfinished.length && !options.dryRun) {
    if (!recovery) {
      const built = mycelium.build('Preserve exact Work-Eater abolition contracts and their admitted negative evidence.', { maxContextChars: 1800 }, () => tissueFor(sweep.contracts, evidence));
      recovery = {
        crystalRoot: built.stats.crystalRoot,
        selectionReceiptHash: built.stats.selectionReceiptHash,
        omittedRecords: built.stats.omittedHashes.length,
        manifestPath: built.stats.manifestPath,
        emittedUtf8Bytes: built.stats.utf8Bytes,
      };
    }
    for (const contract of unfinished) linkRecovery(engine, contract.contractHash, recovery);
  }
  if (recovery && sweep.contracts.length && !options.dryRun) {
    const top = sweep.contracts[0], turnRange = `work-eater:${top.contractHash.slice(7, 23)}`;
    const knownCrystal = loadCrystals(memDir, 100_000).some(item => item.turnRange === turnRange);
    if (!knownCrystal) {
      const crystalText = `Work-Eater navigation only: ${top.signature} contract=${top.contractHash} ledger=${engine.verifyLedger().head} mycelium=${recovery.crystalRoot}. This pointer is not evidence or extinction proof; recover exact tissue and run the independent holdout.`;
      const packet = circulation.legacy('memory-write', 'work-eater');
      const inputBytes = Buffer.byteLength(JSON.stringify({ contract: top, recovery }), 'utf8');
      packet.provenance = top.evidenceRefs.map(ref => ({ sha256: ref.rawHash }));
      packet.completeness = { scope: 'selected', read_bytes: inputBytes, unread_bytes: 0, status: 'complete' };
      packet.loss = { kind: 'navigation', input_bytes: inputBytes, output_bytes: Buffer.byteLength(crystalText, 'utf8'), status: 'lossless-via-mycelium' };
      appendCrystal(
        crystalText,
        turnRange,
        memDir,
        packet
      );
    }
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    schema: 1,
    organ: 'work-eater',
    objective: 'starve the organism by abolishing recurrent work at its source',
    dryRun: Boolean(options.dryRun),
    admittedEvidence: evidence.length,
    rankedContracts: sweep.contracts.map(publicContract),
    createdContracts: sweep.created.map(item => item.contract.contractHash),
    ecologyLinks: links,
    recovery,
    ledger: engine.verifyLedger(),
    durationMs: Number(durationMs.toFixed(3)),
    heapUsed: process.memoryUsage().heapUsed,
  };
}

if (require.main === module) {
  try {
    const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
    const report = runSweep({ limit: limitArg ? Number(limitArg.split('=')[1]) : 3, dryRun: process.argv.includes('--dry-run') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`WORK-EATER FAIL: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runSweep };
