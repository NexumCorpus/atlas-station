'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./gauntlet-protocol.cjs');
const ledger = require('./gauntlet-ledger.cjs');
const rfc8259 = require('./gauntlet-rfc8259.cjs');

const DEFAULT_LEDGER = path.join(__dirname, 'memory', 'gauntlet.ndjson');

async function nextNistPulse(afterMs, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `https://beacon.nist.gov/beacon/2.0/pulse/time/next/${afterMs}`;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let response;
    try { response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(Math.min(10_000, remaining)) }); }
    catch (error) { if (Date.now() >= deadline) break; if (error.name === 'TimeoutError') continue; throw error; }
    if (response.ok) return response.json();
    if (response.status !== 404) throw new Error(`NIST Beacon HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`no NIST pulse became available after ${afterMs} within ${timeoutMs}ms`);
}

function fixturePulse(afterMs, freezeDigest) {
  const output = protocol.digest(`fixture:${afterMs}:${freezeDigest}`).repeat(2).toUpperCase();
  return { pulse: { uri: 'fixture:gauntlet-diagnostic', chainIndex: 0, pulseIndex: 0, timeStamp: new Date(afterMs + 1).toISOString(), outputValue: output, signatureValue: '', listValues: [] } };
}

async function runRfc8259Proof({ ledgerPath = DEFAULT_LEDGER, liveBeacon = false, trialCount = 16 } = {}) {
  const started = process.hrtime.bigint();
  const frozen = protocol.freeze(rfc8259.claimSpec());
  ledger.appendRecord(ledgerPath, 'FROZEN', frozen);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const witnessed = protocol.witness(frozen, {
    witnessId: liveBeacon ? 'local-operator-awaiting-public-pulse' : 'self-witnessed-diagnostic',
    privateKey, publicKey, independence: 'self',
  });
  ledger.appendRecord(ledgerPath, 'WITNESSED', witnessed);
  const envelope = liveBeacon ? await nextNistPulse(frozen.beaconAfterMs) : fixturePulse(frozen.beaconAfterMs, frozen.freezeDigest);
  const seeded = protocol.admitPulse(frozen, witnessed, envelope, { allowFixture: !liveBeacon, trustedTransport: liveBeacon });
  ledger.appendRecord(ledgerPath, 'SEEDED', seeded);
  const run = rfc8259.run(frozen, seeded, trialCount);
  ledger.appendRecord(ledgerPath, 'RUN', run);
  const settlement = protocol.settle(run, { frozen, witnessed, seeded, verifyRun: rfc8259.verifyRun });
  ledger.appendRecord(ledgerPath, 'SETTLED', settlement);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    frozen, witnessed, seeded, run, settlement,
    metrics: { elapsedMs: Math.round(elapsedMs * 1000) / 1000, trialCount: run.trials.length, ledgerBytes: fs.statSync(ledgerPath).size },
    projection: ledger.projection(ledgerPath),
  };
}

function inspectGauntlet(ledgerPath = DEFAULT_LEDGER) {
  return ledger.projection(ledgerPath);
}

function supersedeGauntlet({ ledgerPath = DEFAULT_LEDGER, settlementHash, counterexample }) {
  const records = ledger.verifyLedger(ledgerPath).records;
  const settled = records.find((record) => record.kind === 'SETTLED' && record.payload?.settlementHash === settlementHash)?.payload;
  if (!settled) throw new Error(`settlement not found: ${settlementHash}`);
  const artifact = protocol.supersede(settled, counterexample);
  const record = ledger.appendRecord(ledgerPath, 'SUPERSEDED', artifact);
  return { artifact, record, projection: ledger.projection(ledgerPath) };
}

module.exports = { DEFAULT_LEDGER, nextNistPulse, runRfc8259Proof, inspectGauntlet, supersedeGauntlet };
