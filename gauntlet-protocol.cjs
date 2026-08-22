'use strict';

const crypto = require('node:crypto');

const HEX_256 = /^[0-9a-f]{64}$/i;
const HEX_512 = /^[0-9a-f]{128}$/i;
const SECRET_KEY = /(^|_)(api.?key|token|secret|password|authorization|credential|private.?key)($|_)/i;

function normalize(value, depth = 0) {
  if (depth > 12) throw new Error('GAUNTLET input exceeds depth 12');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('GAUNTLET numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('GAUNTLET values must be plain JSON data');
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (SECRET_KEY.test(key.replace(/[^a-z0-9]+/gi, '_'))) throw new Error(`secret-shaped key rejected: ${key}`);
    if (value[key] === undefined) throw new Error(`undefined value rejected: ${key}`);
    result[key] = normalize(value[key], depth + 1);
  }
  return result;
}

function canonical(value) {
  return JSON.stringify(normalize(value));
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function boundedText(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${name} must be non-empty and at most ${max} bytes`);
  }
  return value;
}

function freeze(spec, frozenAtMs = Date.now()) {
  if (!spec || typeof spec !== 'object') throw new Error('GAUNTLET spec is required');
  if (!Number.isSafeInteger(frozenAtMs) || frozenAtMs < 0) throw new Error('frozenAtMs must be a safe epoch millisecond');
  boundedText(spec.claim?.statement, 'claim.statement', 4096);
  if (!spec.evidenceBoundary || typeof spec.evidenceBoundary !== 'object' || Array.isArray(spec.evidenceBoundary) || !Object.keys(spec.evidenceBoundary).length) throw new Error('evidenceBoundary must be a non-empty object');
  if (!spec.lossRule || typeof spec.lossRule !== 'object' || Array.isArray(spec.lossRule)) throw new Error('lossRule must be an object');
  boundedText(spec.lossRule.kind, 'lossRule.kind', 256);
  boundedText(spec.lossRule.failureUnit, 'lossRule.failureUnit', 512);
  if (!Array.isArray(spec.generators) || spec.generators.length < 2 || spec.generators.length > 8) {
    throw new Error('two through eight generators are required');
  }
  const generators = spec.generators.map((g) => ({
    id: boundedText(g.id, 'generator.id', 128),
    version: boundedText(g.version, 'generator.version', 64),
    implementationHash: boundedText(g.implementationHash, 'generator.implementationHash', 64).toLowerCase(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(generators.map((g) => g.id)).size !== generators.length) throw new Error('generator ids must be distinct');
  if (new Set(generators.map((g) => g.implementationHash)).size !== generators.length || generators.some((g) => !HEX_256.test(g.implementationHash))) {
    throw new Error('generator implementation hashes must be distinct SHA-256 values');
  }
  const frozenSpec = normalize({ ...spec, generators });
  const bytes = canonical(frozenSpec);
  if (Buffer.byteLength(bytes) > 65_536) throw new Error('GAUNTLET spec exceeds 65536 bytes');
  const core = { schema: 1, state: 'FROZEN', frozenAtMs, beaconAfterMs: frozenAtMs + 5_000, spec: frozenSpec };
  return { ...core, freezeDigest: digest(core) };
}

function witnessMessage(frozen, witnessId, observedAtMs, independence) {
  return canonical({ domain: 'GAUNTLET-FREEZE-WITNESS-v1', freezeDigest: frozen.freezeDigest, witnessId, observedAtMs, independence, beaconAfterMs: frozen.beaconAfterMs });
}

function witness(frozen, { witnessId, privateKey, publicKey, observedAtMs = Date.now(), independence = 'self' }) {
  if (frozen?.state !== 'FROZEN' || digest({ schema: frozen.schema, state: frozen.state, frozenAtMs: frozen.frozenAtMs, beaconAfterMs: frozen.beaconAfterMs, spec: frozen.spec }) !== frozen.freezeDigest) {
    throw new Error('invalid frozen artifact');
  }
  boundedText(witnessId, 'witnessId', 256);
  if (!['self', 'counterparty', 'public-log'].includes(independence)) throw new Error('invalid witness independence class');
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < frozen.frozenAtMs) throw new Error('witness cannot predate freeze');
  const derivedPublic = publicKey || crypto.createPublicKey(privateKey);
  const exportablePublic = derivedPublic.type === 'public' ? derivedPublic : crypto.createPublicKey(derivedPublic);
  const message = witnessMessage(frozen, witnessId, observedAtMs, independence);
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
  const artifact = {
    schema: 1, state: 'WITNESSED', freezeDigest: frozen.freezeDigest, beaconAfterMs: frozen.beaconAfterMs,
    witnessId, observedAtMs, independence, algorithm: 'Ed25519',
    publicKey: exportablePublic.export({ type: 'spki', format: 'pem' }), signature,
  };
  verifyWitness(frozen, artifact);
  return artifact;
}

function verifyWitness(frozen, artifact) {
  if (artifact?.state !== 'WITNESSED' || artifact.freezeDigest !== frozen.freezeDigest || artifact.beaconAfterMs !== frozen.beaconAfterMs) {
    throw new Error('witness does not bind the frozen artifact');
  }
  if (!Number.isSafeInteger(artifact.observedAtMs) || artifact.observedAtMs < frozen.frozenAtMs) throw new Error('invalid witness time');
  if (!['self', 'counterparty', 'public-log'].includes(artifact.independence)) throw new Error('invalid witness independence class');
  const ok = crypto.verify(null, Buffer.from(witnessMessage(frozen, artifact.witnessId, artifact.observedAtMs, artifact.independence)), artifact.publicKey, Buffer.from(artifact.signature, 'base64'));
  if (!ok) throw new Error('invalid freeze witness signature');
  return true;
}

function admitPulse(frozen, witnessed, envelope, { allowFixture = false, trustedTransport = false } = {}) {
  verifyWitness(frozen, witnessed);
  const pulse = envelope?.pulse || envelope;
  const pulseTimeMs = Date.parse(pulse?.timeStamp);
  if (!Number.isFinite(pulseTimeMs) || pulseTimeMs <= witnessed.observedAtMs || pulseTimeMs <= frozen.beaconAfterMs) {
    throw new Error('beacon pulse must follow freeze witness and committed future boundary');
  }
  if (!HEX_512.test(pulse.outputValue || '')) throw new Error('beacon outputValue must be 512-bit hexadecimal');
  const fixture = String(pulse.uri || '').startsWith('fixture:');
  if (fixture && !allowFixture) throw new Error('fixture pulse is not admissible on a live route');
  if (!fixture && !trustedTransport) throw new Error('live pulse envelopes must arrive through the bounded HTTPS fetch route');
  if (!fixture) {
    const uri = new URL(pulse.uri);
    if (uri.protocol !== 'https:' || uri.hostname !== 'beacon.nist.gov') throw new Error('pulse URI must be NIST Beacon HTTPS');
  }
  const source = {
    service: fixture ? 'diagnostic-fixture' : 'NIST Randomness Beacon 2.0 beta (claimed URI; signature unverified)', uri: pulse.uri,
    chainIndex: pulse.chainIndex ?? null, pulseIndex: pulse.pulseIndex ?? null, timeStamp: pulse.timeStamp,
    outputValue: pulse.outputValue.toUpperCase(), rawHash: digest(envelope),
    signatureRecorded: typeof pulse.signatureValue === 'string' && pulse.signatureValue.length > 0,
    signatureVerified: false,
    transportObserved: !fixture && trustedTransport,
    priorLinkRecorded: Array.isArray(pulse.listValues) && pulse.listValues.some((v) => v?.type === 'previous'),
  };
  const core = { schema: 1, state: 'SEEDED', freezeDigest: frozen.freezeDigest, witnessDigest: digest(witnessed), source };
  return { ...core, seededDigest: digest(core) };
}

function trialSeed(frozen, seeded, generatorId, index) {
  if (seeded?.freezeDigest !== frozen.freezeDigest || !Number.isInteger(index) || index < 0 || index > 255) throw new Error('invalid trial derivation input');
  return digest(`${frozen.freezeDigest}:${seeded.source.outputValue}:${generatorId}:${index}`);
}

function settle(run, { frozen, witnessed, seeded, verifyRun } = {}) {
  if (run?.state !== 'RUN' || !Array.isArray(run.trials) || run.trials.length === 0) throw new Error('complete run required');
  if (frozen?.freezeDigest !== run.freezeDigest || seeded?.seededDigest !== run.seededDigest || seeded?.freezeDigest !== frozen.freezeDigest) throw new Error('run provenance mismatch');
  const { runDigest, ...runCore } = run;
  if (runDigest !== digest(runCore)) throw new Error('run digest mismatch');
  verifyWitness(frozen, witnessed);
  if (typeof verifyRun !== 'function' || verifyRun(frozen, seeded, run) !== true) throw new Error('run verifier rejected artifact');
  const passed = run.trials.every((trial) => trial.pass === true);
  const core = {
    schema: 1, state: 'SETTLED', freezeDigest: run.freezeDigest, runDigest: run.runDigest,
    verdict: passed ? 'SURVIVED' : 'FAILED', failures: run.trials.filter((trial) => !trial.pass).map((trial) => trial.trialId),
    witnessIndependence: witnessed.independence, beaconSignatureVerified: seeded.source.signatureVerified, commercialClaim: false,
    claimCeiling: passed
      ? `survived every trial derived from the frozen generators under ${seeded.source.service} pulse ${run.pulseIndex ?? 'unknown'}`
      : 'failed at least one disclosed derived trial; no correctness claim is available',
  };
  return { ...core, settlementHash: digest(core) };
}

function supersede(settlement, counterexample) {
  if (settlement?.state !== 'SETTLED') throw new Error('settled artifact required');
  boundedText(counterexample?.description, 'counterexample.description', 4096);
  const core = { schema: 1, state: 'SUPERSEDED', freezeDigest: settlement.freezeDigest, settlementHash: settlement.settlementHash, counterexample: normalize(counterexample), claimCeiling: 'the prior receipt remains historical evidence but no longer supports a current survival claim' };
  return { ...core, supersessionHash: digest(core) };
}

module.exports = { canonical, digest, normalize, freeze, witness, verifyWitness, admitPulse, trialSeed, settle, supersede };
