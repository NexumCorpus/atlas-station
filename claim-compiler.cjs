'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const { validateFormalModel } = require('./claim-logic.cjs');

const LIMITS = Object.freeze({ bytes: 262144, propositions: 32, evidence: 64, scores: 128, text: 4096 });
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const ID = /^[A-Z][A-Z0-9_:.-]{0,127}$/;

function sortValue(value, ancestors = new WeakSet()) {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('cyclic value');
    ancestors.add(value);
    const sorted = Array.isArray(value)
      ? value.map(item => sortValue(item, ancestors))
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key], ancestors)]));
    ancestors.delete(value);
    return sorted;
  }
  return value;
}

function canonical(value) { return JSON.stringify(sortValue(value)); }
function hash(value) { return `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`; }
function fail(stage, reason) { const error = new Error(reason); error.stage = stage; throw error; }

function parseArtifact(input) {
  let bytes;
  if (Buffer.isBuffer(input)) bytes = input;
  else if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else {
    let encoded;
    try { encoded = canonical(input); }
    catch (error) { fail('shape', error.message === 'cyclic value' ? 'artifact object must be acyclic' : 'artifact object cannot be canonicalized'); }
    if (typeof encoded !== 'string') fail('encoding', 'artifact input has no JSON representation');
    bytes = Buffer.from(encoded, 'utf8');
  }
  if (bytes.length < 2 || bytes.length > LIMITS.bytes) fail('encoding', `artifact bytes must be 2 through ${LIMITS.bytes}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('encoding', 'artifact is not strict UTF-8'); }
  let artifact;
  try { artifact = JSON.parse(text); } catch (error) { fail('encoding', `artifact JSON is invalid: ${error.message}`); }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail('shape', 'artifact must be an object');
  return artifact;
}

function array(value, name, maximum, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > maximum) fail('shape', `${name} must contain ${allowEmpty ? '0' : '1'} through ${maximum} entries`);
  return value;
}

function uniqueObjects(items, name) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !ID.test(item.id)) fail('shape', `${name} requires canonical object ids`);
    if (ids.has(item.id)) fail('shape', `duplicate ${name} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function boundedScores(values, name) {
  array(values, name, LIMITS.scores);
  if (values.some(value => !Number.isFinite(value))) fail('evidence', `${name} must contain finite numbers`);
  return values;
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function verifyHoldoutGain(predicate, evidence, options) {
  if (!options.trustedExecution) fail('authority', 'software behavior claims require the trusted execution adapter');
  const proof = evidence.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) fail('evidence', 'independent holdout proof is required');
  if (!ACTOR.test(String(proof.candidateActor || '')) || !ACTOR.test(String(proof.graderActor || ''))) fail('authority', 'candidate and grader actors are required');
  if (proof.candidateActor === proof.graderActor || proof.candidateActor === options.verifierActor || proof.graderActor === options.verifierActor) fail('authority', 'candidate, grader, and compiler actors must be independent');
  const baselineScores = boundedScores(proof.baselineScores, 'baselineScores');
  const candidateScores = boundedScores(proof.candidateScores, 'candidateScores');
  if (baselineScores.length !== candidateScores.length) fail('evidence', 'paired score lengths differ');
  if (!proof.holdout || typeof proof.holdout !== 'object' || !proof.holdout.reveal || !Array.isArray(proof.holdout.reveal.cases) || typeof proof.holdout.reveal.salt !== 'string' || !proof.holdout.reveal.salt) fail('evidence', 'holdout reveal requires cases and salt');
  if (proof.holdout.commitment !== hash({ cases: proof.holdout.reveal.cases, salt: proof.holdout.reveal.salt })) fail('evidence', 'holdout commitment mismatch');
  if (!Number.isFinite(proof.holdout.committedAt) || !Number.isFinite(proof.startedAt) || proof.holdout.committedAt > proof.startedAt) fail('evidence', 'holdout was not committed before execution');
  if (!Array.isArray(proof.falsifiers) || proof.falsifiers.length > LIMITS.evidence) fail('evidence', 'falsifiers must be a bounded list');
  const failedFalsifiers = proof.falsifiers.filter(item => item && item.failed).length;
  const gain = mean(candidateScores) - mean(baselineScores);
  if (!Number.isFinite(predicate.minGain) || predicate.minGain !== options.expectedMinGain) fail('semantics', 'predicate minimum gain differs from the trusted policy');
  if (predicate.candidatePolicyHash !== proof.candidatePolicyHash) fail('semantics', 'predicate policy hash differs from evidence');
  if (gain < predicate.minGain) fail('proof', `candidate gain ${gain} is below ${predicate.minGain}`);
  if (failedFalsifiers) fail('proof', `${failedFalsifiers} falsifier(s) triggered`);
  return { gain, baseline: mean(baselineScores), candidate: mean(candidateScores), pairs: baselineScores.length };
}

function compileClaim(input, options = {}) {
  const verifierActor = options.verifierActor || 'hermes:claim-compiler-v1';
  let artifactHash = null;
  try {
    if (!ACTOR.test(verifierActor)) fail('authority', 'invalid verifier actor');
    const artifact = parseArtifact(input);
    artifactHash = hash(artifact);
    if (artifact.schema !== 1) fail('shape', 'unsupported claim schema');
    if (!ACTOR.test(String(artifact.generatorActor || ''))) fail('authority', 'generatorActor is required');
    if (artifact.generatorActor === verifierActor) fail('authority', 'generator cannot be the claim compiler');
    const propositions = array(artifact.propositions, 'propositions', LIMITS.propositions);
    const evidence = array(artifact.evidence, 'evidence', LIMITS.evidence);
    const propositionIds = uniqueObjects(propositions, 'proposition');
    uniqueObjects(evidence, 'evidence');
    const evidenceById = new Map(evidence.map(item => [item.id, item]));
    for (const item of evidence) {
      if (!propositionIds.has(item.propositionId)) fail('binding', `evidence ${item.id} points to unknown proposition ${String(item.propositionId)}`);
    }
    const results = [];
    for (const proposition of propositions) {
      if (!proposition.predicate || typeof proposition.predicate !== 'object' || Array.isArray(proposition.predicate) || typeof proposition.predicate.kind !== 'string') fail('shape', `proposition ${proposition.id} has a malformed predicate`);
      if (!Array.isArray(proposition.evidenceRefs) || proposition.evidenceRefs.length < 1 || proposition.evidenceRefs.length > LIMITS.evidence || new Set(proposition.evidenceRefs).size !== proposition.evidenceRefs.length) fail('binding', `proposition ${proposition.id} requires unique evidence references`);
      if (proposition.text != null && (typeof proposition.text !== 'string' || Buffer.byteLength(proposition.text, 'utf8') > LIMITS.text)) fail('shape', `proposition ${proposition.id} annotation is invalid`);
      const bound = proposition.evidenceRefs.map(id => {
        const item = evidenceById.get(id);
        if (!item) fail('binding', `proposition ${proposition.id} references missing evidence ${String(id)}`);
        if (item.propositionId !== proposition.id) fail('binding', `evidence ${id} belongs to ${item.propositionId}, not ${proposition.id}`);
        return item;
      });
      const tuple = `${proposition.scope}|${proposition.predicate.kind}|${bound.map(item => item.kind).sort().join('+')}`;
      if (tuple === 'FORMAL_MODEL|IS_MINIMAL_UNSAT_CORE|PROOF' && bound.length === 1) {
        let proof;
        try { proof = validateFormalModel(artifact.formalModel, proposition.predicate); }
        catch (error) {
          const stage = /variable|namespace|declaration|root references/.test(error.message) ? 'shape' : 'proof';
          fail(stage, error.message);
        }
        results.push({ propositionId: proposition.id, tuple, proof });
      } else if (tuple === 'SOFTWARE_BEHAVIOR|INDEPENDENT_HOLDOUT_GAIN|PROOF' && bound.length === 1) {
        results.push({ propositionId: proposition.id, tuple, proof: verifyHoldoutGain(proposition.predicate, bound[0], { ...options, verifierActor }) });
      } else fail('semantics', `unsupported verifier tuple: ${tuple}`);
    }
    return { schema: 1, verdict: 'admitted', artifactHash, generatorActor: artifact.generatorActor, verifierActor, results };
  } catch (error) {
    return { schema: 1, verdict: 'rejected', artifactHash, stage: error.stage || 'internal', reason: String(error.message || error), verifierActor };
  }
}

module.exports = { LIMITS, canonical, hash, compileClaim };
