'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { index, validateCapsule, sha } = require('./skill-capsule.cjs');
const fitness = require('./skill-fitness.cjs');
const gauntletLedger = require('./gauntlet-ledger.cjs');
const gauntletProtocol = require('./gauntlet-protocol.cjs');

const CANDIDATES = path.join(__dirname, 'memory', 'skill-candidates');
const ADMITTED = path.join(__dirname, 'memory', 'skill-variants');
const TRUSTED_WITNESSES = path.join(__dirname, 'config', 'trusted-skill-witnesses.json');

function safeSegment(value, label) {
  if (!/^[a-z0-9][a-z0-9.@-]{1,95}$/.test(String(value || ''))) throw new Error(`invalid ${label}`);
  return String(value);
}

function writeExclusive(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, value, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || fs.readFileSync(target, 'utf8') !== value) throw error;
  }
}

function stageVariant(input, ledgerPath) {
  const capsule = input?.capsule;
  const body = String(input?.body || '');
  const reason = input?.failureEvidence;
  if (!reason || !reason.id || !/^[a-f0-9]{64}$/.test(reason.hash) || !reason.ts) throw new Error('variant requires witnessed failure evidence');
  const name = safeSegment(capsule?.name, 'skill name');
  const version = safeSegment(capsule?.version, 'skill version');
  validateCapsule(capsule, body, `${name}@${version}`);
  const id = `${name}@${version}-${sha(body).slice(0, 12)}`;
  const incumbent = index().skills.find(skill => skill.name === name);
  if (!incumbent) throw new Error('variant requires an installed incumbent skill');
  const comparison = { kind: 'skill-variant-comparison', subject: id, candidateBodyHash: sha(body), incumbentBodyHash: incumbent.bodyHash };
  const folder = path.join(CANDIDATES, id);
  const existingBody = path.join(folder, 'SKILL.md');
  const existingCapsule = path.join(folder, 'capsule.json');
  if (fs.existsSync(existingBody) && fs.existsSync(existingCapsule)) {
    if (fs.readFileSync(existingBody, 'utf8') !== body || sha(JSON.stringify(JSON.parse(fs.readFileSync(existingCapsule, 'utf8')))) !== sha(JSON.stringify(capsule))) throw new Error('staged variant identity collision');
    const prior = fitness.read(ledgerPath).find(row => row.kind === 'variant-staged' && row.id === id);
    return { id, folder, receiptHash: prior?.recordHash || null, alreadyStaged: true, requiredComparison: comparison };
  }
  writeExclusive(path.join(folder, 'SKILL.md'), body);
  writeExclusive(path.join(folder, 'capsule.json'), `${JSON.stringify(capsule, null, 2)}\n`);
  const receipt = fitness.append('variant-staged', { id, name, version, bodyHash: sha(body), failureEvidence: reason }, ledgerPath);
  return { id, folder, receiptHash: receipt.recordHash, requiredComparison: comparison };
}

function settlementEvidence(input, id, candidateBodyHash, incumbentBodyHash) {
  const proofPath = path.resolve(input?.gauntletLedgerPath || path.join(__dirname, 'memory', 'gauntlet.ndjson'));
  const relative = path.relative(__dirname, proofPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('GAUNTLET ledger escapes Atlas repository');
  const records = gauntletLedger.verifyLedger(proofPath).records;
  const settledRecord = records.find(record => record.kind === 'SETTLED' && record.recordHash === input.settlementRecordHash && record.payload?.settlementHash === input.settlementHash);
  if (!settledRecord || settledRecord.payload.verdict !== 'SURVIVED') throw new Error('variant admission requires a recorded SURVIVED settlement');
  const claim = records.filter(record => record.payload?.freezeDigest === settledRecord.payload.freezeDigest);
  if (claim.map(record => record.kind).join(',') !== 'FROZEN,WITNESSED,SEEDED,RUN,SETTLED') throw new Error('variant admission requires a complete ordered GAUNTLET claim');
  const [frozenRecord, witnessedRecord, seededRecord, runRecord] = claim;
  const frozen = frozenRecord.payload, witnessed = witnessedRecord.payload, seeded = seededRecord.payload, run = runRecord.payload, settled = settledRecord.payload;
  const frozenCore = { schema: frozen.schema, state: frozen.state, frozenAtMs: frozen.frozenAtMs, beaconAfterMs: frozen.beaconAfterMs, spec: frozen.spec };
  if (gauntletProtocol.digest(frozenCore) !== frozen.freezeDigest) throw new Error('variant freeze digest mismatch');
  gauntletProtocol.verifyWitness(frozen, witnessed);
  const registry = JSON.parse(fs.readFileSync(TRUSTED_WITNESSES, 'utf8'));
  const trusted = registry.schema === 1 && registry.witnesses.find(item => item.id === witnessed.witnessId);
  const publicDer = crypto.createPublicKey(witnessed.publicKey).export({ type: 'spki', format: 'der' });
  if (!trusted || trusted.publicKeySha256 !== sha(publicDer) || !['counterparty', 'public-log'].includes(witnessed.independence)) throw new Error('variant admission witness is not pinned in the trusted registry');
  const { seededDigest, ...seededCore } = seeded;
  if (seeded.freezeDigest !== frozen.freezeDigest || seeded.witnessDigest !== gauntletProtocol.digest(witnessed) || seededDigest !== gauntletProtocol.digest(seededCore)) throw new Error('variant seeded artifact mismatch');
  const pulseTime = Date.parse(seeded.source?.timeStamp);
  if (!Number.isFinite(pulseTime) || pulseTime <= frozen.beaconAfterMs || pulseTime <= witnessed.observedAtMs) throw new Error('variant seed is not temporally ordered');
  const { runDigest, ...runCore } = run;
  if (run.freezeDigest !== frozen.freezeDigest || run.seededDigest !== seeded.seededDigest || runDigest !== gauntletProtocol.digest(runCore)) throw new Error('variant run artifact mismatch');
  const { settlementHash, ...settledCore } = settled;
  if (settled.runDigest !== run.runDigest || settlementHash !== gauntletProtocol.digest(settledCore)) throw new Error('variant settlement artifact mismatch');
  const boundary = frozen.spec?.evidenceBoundary;
  if (frozen.spec?.claim?.kind !== 'skill-variant-comparison' || frozen.spec?.claim?.subject !== id || boundary?.candidateBodyHash !== candidateBodyHash || boundary?.incumbentBodyHash !== incumbentBodyHash) throw new Error('GAUNTLET claim is not bound to this skill comparison');
  return { settledRecord, proofPath };
}

function admitVariant(input, ledgerPath) {
  const id = safeSegment(input?.id, 'candidate id');
  if (!/^[a-f0-9]{64}$/.test(input?.settlementHash || '') || !/^[a-f0-9]{64}$/.test(input?.settlementRecordHash || '')) throw new Error('variant admission requires settlement and ledger record hashes');
  const source = path.join(CANDIDATES, id);
  if (!fs.existsSync(source)) throw new Error('unknown staged variant');
  const capsule = JSON.parse(fs.readFileSync(path.join(source, 'capsule.json'), 'utf8'));
  const body = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  validateCapsule(capsule, body, id);
  const incumbent = index().skills.find(skill => skill.name === capsule.name);
  if (!incumbent) throw new Error('variant incumbent is not installed');
  const { settledRecord } = settlementEvidence(input, id, sha(body), incumbent.bodyHash);
  if (fitness.read(ledgerPath).some(row => row.kind === 'variant-admitted' && row.settlementRecordHash === settledRecord.recordHash)) throw new Error('GAUNTLET settlement was already consumed by a skill admission');
  const target = path.join(ADMITTED, capsule.name, capsule.version);
  const targetBody = path.join(target, 'SKILL.md');
  const targetCapsule = path.join(target, 'capsule.json');
  if (fs.existsSync(targetBody) && fs.existsSync(targetCapsule)) {
    if (fs.readFileSync(targetBody, 'utf8') !== body || sha(JSON.stringify(JSON.parse(fs.readFileSync(targetCapsule, 'utf8')))) !== sha(JSON.stringify(capsule))) throw new Error('admitted skill version collision');
    const prior = fitness.read(ledgerPath).find(row => row.kind === 'variant-admitted' && row.id === id);
    return { id, target, receiptHash: prior?.recordHash || null, alreadyAdmitted: true };
  }
  const staging = `${target}.admitting-${process.pid}-${Date.now()}`;
  writeExclusive(path.join(staging, 'SKILL.md'), body);
  writeExclusive(path.join(staging, 'capsule.json'), `${JSON.stringify(capsule, null, 2)}\n`);
  let receipt;
  try {
    receipt = fitness.append('variant-admitted', { id, name: capsule.name, version: capsule.version, bodyHash: sha(body), settlementHash: settledRecord.payload.settlementHash, settlementRecordHash: settledRecord.recordHash }, ledgerPath);
    writeExclusive(path.join(staging, 'admission.json'), `${JSON.stringify({ schema: 1, bodyHash: sha(body), receiptHash: receipt.recordHash }, null, 2)}\n`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return { id, target, receiptHash: receipt.recordHash };
}

module.exports = { ADMITTED, CANDIDATES, admitVariant, stageVariant };
