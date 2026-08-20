'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { compileClaim } = require('./claim-compiler.cjs');

const LEDGER = 'xenobiotic-ecology.ndjson';
const LEDGER_LOCK = 'xenobiotic-ecology.lock';
const MAX_TEXT_BYTES = 16 * 1024;
const SENSITIVE_KEYS = /^(token|secret|password|api[-_]?key|authorization|cookie)$/i;

const CASTES = Object.freeze({
  forager: Object.freeze({
    purpose: 'evidence acquisition',
    model: 'gpt-5.5',
    mode: 'read',
    tools: Object.freeze(['read', 'search', 'station-hermes-ask']),
    fallback: 'cartographer',
    budget: Object.freeze({ tokens: 12_000, wallMs: 180_000, toolCalls: 24, mutations: 0 }),
  }),
  pathogen: Object.freeze({
    purpose: 'falsification and poison detection',
    model: 'gpt-5.6-terra',
    mode: 'read',
    tools: Object.freeze(['boundary', 'independent-receipts', 'tests']),
    fallback: 'undertaker',
    budget: Object.freeze({ tokens: 18_000, wallMs: 300_000, toolCalls: 32, mutations: 0 }),
  }),
  symbiont: Object.freeze({
    purpose: 'cross-organ synthesis',
    model: 'gpt-5.6-luna',
    mode: 'orchestrator',
    tools: Object.freeze(['decision-loop', 'crystals', 'context-mycelium']),
    fallback: 'cartographer',
    budget: Object.freeze({ tokens: 24_000, wallMs: 420_000, toolCalls: 36, mutations: 0 }),
  }),
  undertaker: Object.freeze({
    purpose: 'apoptosis quarantine and rollback',
    model: 'gpt-5.6-terra',
    mode: 'build',
    tools: Object.freeze(['decision-loop', 'mutation-map', 'git']),
    fallback: 'pathogen',
    budget: Object.freeze({ tokens: 20_000, wallMs: 360_000, toolCalls: 30, mutations: 1 }),
  }),
  cartographer: Object.freeze({
    purpose: 'lineage context and dependency mapping',
    model: 'gpt-5.5',
    mode: 'read',
    tools: Object.freeze(['memgraph', 'spoor', 'crystals']),
    fallback: 'forager',
    budget: Object.freeze({ tokens: 10_000, wallMs: 180_000, toolCalls: 20, mutations: 0 }),
  }),
  'instrument-builder': Object.freeze({
    purpose: 'measurement and holdout construction',
    model: 'gpt-5.6-terra',
    mode: 'build',
    tools: Object.freeze(['causal-xenosoma', 'independent-receipts', 'tests']),
    fallback: 'pathogen',
    budget: Object.freeze({ tokens: 24_000, wallMs: 480_000, toolCalls: 40, mutations: 1 }),
  }),
});

const DEFAULT_LIMITS = Object.freeze({
  maxCells: 24,
  maxPerNiche: 4,
  maxRecruitPerCycle: 8,
  maxSignalsPerCycle: 64,
  maxProjectionRecords: 512,
  maxEventsInSnapshot: 12,
  minNoveltyGain: 0.05,
});

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(sortValue(value));
}

function hash(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonical(value);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function withWriterLock(lockPath, operation) {
  let descriptor = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { descriptor = fs.openSync(lockPath, 'wx'); break; }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 60000) fs.unlinkSync(lockPath); } catch {}
      sleep(Math.min(5, Math.max(1, deadline - Date.now())));
    }
  }
  if (descriptor == null) throw new Error('ecology ledger writer lock timeout');
  try {
    fs.writeSync(descriptor, `${process.pid}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const numbers = values.map(value => finite(value, NaN));
  return numbers.every(Number.isFinite)
    ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
    : null;
}

function assertBoundedText(value, label = 'text') {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error(`${label} exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  return text;
}

function assertNoSecrets(value, trail = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\s._-]/gu, '');
    if (SENSITIVE_KEYS.test(normalizedKey)) throw new Error(`authority leakage rejected at ${[...trail, key].join('.')}`);
    assertNoSecrets(child, [...trail, key]);
  }
}

function gradientFromSignal(signal, now = Date.now()) {
  const statement = assertBoundedText(signal.statement || signal.contradiction || signal.description, 'gradient statement');
  const confidenceA = clamp(finite(signal.confidenceA, 0.5));
  const confidenceB = clamp(finite(signal.confidenceB, 0.5));
  const impact = clamp(finite(signal.impact, 0.5), 0.05, 1);
  const ageMs = Math.max(0, now - finite(signal.observedAt, now));
  const staleness = clamp(ageMs / (7 * 24 * 60 * 60 * 1000));
  const unresolved = 1 - Math.abs(confidenceA - confidenceB);
  const magnitude = clamp((unresolved * 0.55) + (impact * 0.35) + (staleness * 0.10), 0.01, 1);
  const niche = String(signal.niche || signal.area || 'unknown').slice(0, 80);
  const kind = String(signal.kind || 'contradiction').slice(0, 48);
  const gradientId = `gradient:${hash({ statement, niche, kind }).slice(7, 23)}`;
  return {
    gradientId,
    statement,
    niche,
    kind,
    magnitude,
    confidenceA,
    confidenceB,
    impact,
    staleness,
    evidenceRefs: [...new Set((signal.evidenceRefs || []).map(String))].slice(0, 32),
  };
}

function casteSequence(gradient) {
  const text = `${gradient.kind} ${gradient.statement}`.toLowerCase();
  if (/poison|forg|attack|security|contradict|falsif/.test(text)) return ['pathogen', 'forager'];
  if (/fail|regress|rollback|dead|stale/.test(text)) return ['undertaker', 'pathogen'];
  if (/measure|test|instrument|benchmark|unknown/.test(text)) return ['instrument-builder', 'forager'];
  if (/lineage|map|dependency|context|memory/.test(text)) return ['cartographer', 'forager'];
  if (/integrat|synth|cross|organ/.test(text)) return ['symbiont', 'cartographer'];
  return ['forager', 'pathogen'];
}

function validateEvidenceAnchors(anchors = []) {
  const byHash = new Map();
  for (const anchor of anchors) {
    if (!anchor || typeof anchor !== 'object') throw new Error('poisoned evidence: anchor must be an object');
    const content = String(anchor.content == null ? '' : anchor.content);
    const expected = hash(content);
    if (anchor.hash !== expected) throw new Error(`poisoned evidence: forged anchor ${anchor.hash || 'missing'}`);
    if (byHash.has(anchor.hash)) throw new Error(`poisoned evidence: duplicate anchor ${anchor.hash}`);
    byHash.set(anchor.hash, anchor);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(anchorHash) {
    if (visiting.has(anchorHash)) throw new Error(`poisoned evidence: circular citation ${anchorHash}`);
    if (visited.has(anchorHash) || !byHash.has(anchorHash)) return;
    visiting.add(anchorHash);
    for (const parent of byHash.get(anchorHash).parents || []) visit(String(parent));
    visiting.delete(anchorHash);
    visited.add(anchorHash);
  }
  for (const anchorHash of byHash.keys()) visit(anchorHash);
  return { valid: true, count: byHash.size, rootHashes: [...byHash.keys()].filter(key => !(byHash.get(key).parents || []).length) };
}

function holdoutCommitment(reveal) {
  if (!reveal || !Array.isArray(reveal.cases) || !reveal.salt) throw new Error('holdout reveal requires cases and salt');
  return hash({ cases: reveal.cases, salt: reveal.salt });
}

function routeCaste(caste) {
  const contract = CASTES[caste];
  if (!contract) throw new Error(`unknown ecology caste: ${caste}`);
  return { caste, ...contract, tools: [...contract.tools], budget: { ...contract.budget } };
}

class XenobioticEcology {
  constructor(options = {}) {
    this.memDir = path.resolve(options.memDir || path.join(__dirname, 'memory'));
    this.ledgerPath = path.join(this.memDir, LEDGER);
    this.lockPath = path.join(this.memDir, LEDGER_LOCK);
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.clock = options.clock || (() => Date.now());
    this.actor = options.actor || 'ATLAS';
    fs.mkdirSync(this.memDir, { recursive: true });
  }

  records() {
    if (!fs.existsSync(this.ledgerPath)) return [];
    const lines = fs.readFileSync(this.ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const records = [];
    let previous = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      let record;
      try { record = JSON.parse(line); } catch { throw new Error(`ecology ledger contains invalid JSON at seq ${index + 1}`); }
      const body = { ...record };
      delete body.recordHash;
      if (record.recordHash !== hash(body)) throw new Error(`ecology ledger record hash mismatch at seq ${record.seq}`);
      if ((record.prevRecordHash || null) !== previous) throw new Error(`ecology ledger chain mismatch at seq ${record.seq}`);
      previous = record.recordHash;
      records.push(record);
    }
    return records;
  }

  append(kind, payload = {}) {
    assertNoSecrets(payload);
    return withWriterLock(this.lockPath, () => {
      const records = this.records();
      const body = {
        v: 1,
        seq: records.length + 1,
        ts: new Date(this.clock()).toISOString(),
        kind: assertBoundedText(kind, 'record kind').slice(0, 80),
        actor: this.actor,
        prevRecordHash: records.at(-1)?.recordHash || null,
        payload,
      };
      const record = { ...body, recordHash: hash(body) };
      const descriptor = fs.openSync(this.ledgerPath, 'a');
      try { fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8'); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      return record;
    });
  }

  verifyLedger() {
    const records = this.records();
    return { valid: true, records: records.length, head: records.at(-1)?.recordHash || null };
  }

  projection() {
    const all = this.records();
    const records = all.slice(-this.limits.maxProjectionRecords);
    const state = {
      gradients: new Map(),
      cells: new Map(),
      policies: new Map(),
      claims: new Map(),
      deaths: [],
      experiments: [],
      events: records,
      totalRecords: all.length,
      projectionTruncated: all.length > records.length,
    };
    for (const record of records) {
      const payload = record.payload || {};
      if (record.kind === 'gradient') state.gradients.set(payload.gradientId, payload);
      if (record.kind === 'cell-recruited') state.cells.set(payload.cellId, payload);
      if (record.kind === 'metabolism' && state.cells.has(payload.cellId)) {
        const cell = state.cells.get(payload.cellId);
        state.cells.set(payload.cellId, { ...cell, used: payload.used, state: payload.state || cell.state });
      }
      if (record.kind === 'cell-failure' && state.cells.has(payload.cellId)) {
        state.cells.set(payload.cellId, { ...state.cells.get(payload.cellId), state: 'failed', failure: payload.error });
      }
      if (record.kind === 'apoptosis' && state.cells.has(payload.cellId)) {
        state.cells.set(payload.cellId, { ...state.cells.get(payload.cellId), state: 'quarantined', deathReason: payload.reason });
        state.deaths.push(payload);
      }
      if (record.kind === 'experiment-evaluated') state.experiments.push(payload);
      if (record.kind === 'claim-candidate') state.claims.set(payload.claimId, { ...payload, state: 'quarantined' });
      if (record.kind === 'claim-admitted') state.claims.set(payload.claimId, { ...(state.claims.get(payload.claimId) || {}), ...payload, state: 'admitted' });
      if (record.kind === 'claim-rejected') state.claims.set(payload.claimId, { ...(state.claims.get(payload.claimId) || {}), ...payload, state: 'rejected' });
      if (record.kind === 'policy-promoted') state.policies.set(payload.policyHash, { ...payload, state: 'promoted' });
      if (record.kind === 'policy-revoked') {
        const prior = state.policies.get(payload.policyHash) || {};
        state.policies.set(payload.policyHash, { ...prior, ...payload, state: 'revoked' });
      }
    }
    return state;
  }

  ensureBootstrap() {
    const state = this.projection();
    if (state.cells.size) return { created: false, snapshot: this.snapshot() };
    const gradient = gradientFromSignal({
      statement: 'No active ecological cells exist; construct a falsifiable instrument before interpretation.',
      kind: 'empty-bootstrap',
      niche: 'origin',
      impact: 0.8,
    }, this.clock());
    this.append('gradient', gradient);
    const cell = this._recruitCell(gradient, 'instrument-builder', null);
    this.append('bootstrap', { reason: 'empty-ecology', cellId: cell.cellId, gradientId: gradient.gradientId });
    return { created: true, cell, snapshot: this.snapshot() };
  }

  _recruitCell(gradient, caste, parentCellId = null) {
    const state = this.projection();
    const deterministic = `cell:${gradient.gradientId}:${caste}`;
    const existing = [...state.cells.values()].find(cell => cell.deterministicKey === deterministic && !['quarantined', 'failed'].includes(cell.state));
    if (existing) return existing;
    const active = [...state.cells.values()].filter(cell => !['quarantined', 'failed', 'exhausted'].includes(cell.state));
    if (active.length >= this.limits.maxCells) throw new Error(`ecology population overflow: maxCells=${this.limits.maxCells}`);
    const nicheCount = active.filter(cell => cell.niche === gradient.niche).length;
    if (nicheCount >= this.limits.maxPerNiche) throw new Error(`ecology niche overflow: ${gradient.niche}`);
    const contract = routeCaste(caste);
    const cellId = `cell:${hash({ deterministic, parentCellId }).slice(7, 23)}`;
    const cell = {
      cellId,
      deterministicKey: deterministic,
      parentCellId,
      lineageRoot: parentCellId ? (state.cells.get(parentCellId)?.lineageRoot || parentCellId) : cellId,
      gradientId: gradient.gradientId,
      niche: gradient.niche,
      caste,
      purpose: contract.purpose,
      route: { provider: 'codex-cli', model: contract.model, mode: contract.mode },
      tools: contract.tools,
      budget: contract.budget,
      used: { tokens: 0, wallMs: 0, toolCalls: 0, mutations: 0 },
      state: 'recruited',
    };
    this.append('cell-recruited', cell);
    return cell;
  }

  recruit(input = {}) {
    const started = process.hrtime.bigint();
    const signals = [...(input.contradictions || []), ...(input.proposals || [])];
    if (signals.length > this.limits.maxSignalsPerCycle) throw new Error(`ecology signal overflow: max=${this.limits.maxSignalsPerCycle}`);
    if (!signals.length) return this.ensureBootstrap();
    const gradients = signals.map(signal => gradientFromSignal(signal, this.clock()))
      .sort((a, b) => b.magnitude - a.magnitude);
    const cells = [];
    for (const gradient of gradients) {
      const known = this.projection().gradients.has(gradient.gradientId);
      if (!known) this.append('gradient', gradient);
      for (const caste of casteSequence(gradient)) {
        if (cells.length >= this.limits.maxRecruitPerCycle) break;
        try { cells.push(this._recruitCell(gradient, caste, input.parentCellId || null)); } catch (error) {
          const alreadyRecorded = this.projection().events.some(record =>
            record.kind === 'recruitment-backpressure' &&
            record.payload?.gradientId === gradient.gradientId &&
            record.payload?.caste === caste &&
            record.payload?.reason === error.message
          );
          if (!alreadyRecorded) this.append('recruitment-backpressure', { gradientId: gradient.gradientId, caste, reason: error.message });
        }
      }
      if (cells.length >= this.limits.maxRecruitPerCycle) break;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const telemetry = {
      durationMs,
      inputBytes: Buffer.byteLength(canonical(input), 'utf8'),
      ledgerBytes: fs.existsSync(this.ledgerPath) ? fs.statSync(this.ledgerPath).size : 0,
      gradients: gradients.length,
      recruited: cells.length,
    };
    this.append('performance', telemetry);
    return { gradients, cells, telemetry, snapshot: this.snapshot() };
  }

  metabolize(cellId, usage = {}) {
    const cell = this.projection().cells.get(cellId);
    if (!cell) throw new Error(`unknown ecology cell: ${cellId}`);
    const used = {};
    for (const key of ['tokens', 'wallMs', 'toolCalls', 'mutations']) {
      const delta = finite(usage[key], 0);
      if (delta < 0) throw new Error(`negative metabolic usage rejected: ${key}`);
      used[key] = finite(cell.used?.[key], 0) + delta;
    }
    const exhausted = Object.keys(used).some(key => used[key] > finite(cell.budget?.[key], 0));
    const record = this.append('metabolism', { cellId, used, state: exhausted ? 'exhausted' : 'active' });
    if (exhausted) this.append('apoptosis', { cellId, reason: 'metabolic-budget-exceeded', evidenceRefs: [record.recordHash] });
    return { cellId, used, exhausted };
  }

  recordFailure(cellId, error, options = {}) {
    const state = this.projection();
    const cell = state.cells.get(cellId);
    if (!cell) throw new Error(`unknown ecology cell: ${cellId}`);
    const failure = this.append('cell-failure', {
      cellId,
      error: assertBoundedText(error, 'failure').slice(0, 1000),
      recoverable: options.recoverable !== false,
      organ: options.organ || null,
    });
    if (options.recoverable === false) {
      this.append('apoptosis', { cellId, reason: 'unrecoverable-failure', evidenceRefs: [failure.recordHash] });
      return { recovered: false, quarantined: true };
    }
    const fallbackCaste = CASTES[cell.caste].fallback;
    const gradient = state.gradients.get(cell.gradientId) || gradientFromSignal({
      statement: `Recover failed ${cell.caste} cell`,
      niche: cell.niche,
      kind: 'failure-recovery',
      impact: 0.8,
    }, this.clock());
    const fallback = this._recruitCell(gradient, fallbackCaste, cellId);
    this.append('recovery-route', { failedCellId: cellId, fallbackCellId: fallback.cellId, caste: fallbackCaste, failureRecordHash: failure.recordHash });
    return { recovered: true, fallback };
  }

  apoptose(cellId, reason, evidenceRefs = []) {
    if (!this.projection().cells.has(cellId)) throw new Error(`unknown ecology cell: ${cellId}`);
    return this.append('apoptosis', {
      cellId,
      reason: assertBoundedText(reason, 'apoptosis reason').slice(0, 1000),
      evidenceRefs: [...new Set(evidenceRefs.map(String))].slice(0, 32),
    });
  }

  _admitExperimentClaim(input) {
    const propositionId = 'PROP_EXPERIMENT_GAIN';
    const evidenceId = 'PROOF_INDEPENDENT_HOLDOUT';
    const artifact = {
      schema: 1,
      generatorActor: input.candidateActor,
      propositions: [{
        id: propositionId,
        scope: 'SOFTWARE_BEHAVIOR',
        predicate: {
          kind: 'INDEPENDENT_HOLDOUT_GAIN',
          candidatePolicyHash: input.candidatePolicyHash,
          minGain: this.limits.minNoveltyGain,
        },
        evidenceRefs: [evidenceId],
      }],
      evidence: [{
        id: evidenceId,
        kind: 'PROOF',
        propositionId,
        proof: {
          candidateActor: input.candidateActor,
          graderActor: input.graderActor,
          candidatePolicyHash: input.candidatePolicyHash,
          baselineScores: input.baselineScores,
          candidateScores: input.candidateScores,
          falsifiers: input.falsifiers || [],
          holdout: input.holdout,
          startedAt: input.startedAt,
        },
      }],
    };
    const artifactHash = hash(artifact);
    const claimId = `claim:${artifactHash.slice(7, 23)}`;
    const existing = this.projection().events.find(record =>
      (record.kind === 'claim-admitted' || record.kind === 'claim-rejected') &&
      record.payload?.claimId === claimId && record.payload?.artifactHash === artifactHash
    );
    if (existing) {
      return {
        claimId,
        artifactHash,
        record: existing,
        result: { verdict: existing.kind === 'claim-admitted' ? 'admitted' : 'rejected', stage: existing.payload.stage, reason: existing.payload.reason },
      };
    }
    const candidate = this.append('claim-candidate', {
      claimId,
      artifactHash,
      generatorActor: input.candidateActor,
      propositionId,
      evidenceIds: [evidenceId],
      authority: 'none',
    });
    const result = compileClaim(artifact, {
      trustedExecution: true,
      expectedMinGain: this.limits.minNoveltyGain,
      verifierActor: 'hermes:claim-compiler-v1',
    });
    const record = this.append(result.verdict === 'admitted' ? 'claim-admitted' : 'claim-rejected', {
      claimId,
      artifactHash,
      candidateRecordHash: candidate.recordHash,
      generatorActor: input.candidateActor,
      verifierActor: result.verifierActor,
      stage: result.stage || 'verified',
      reason: result.reason || 'registered predicate verified',
      proof: result.results?.[0]?.proof || null,
    });
    return { claimId, artifactHash, record, result };
  }

  evaluateExperiment(input = {}) {
    assertNoSecrets(input);
    const anchors = validateEvidenceAnchors(input.anchors || []);
    if (!input.candidateActor || !input.graderActor || input.candidateActor === input.graderActor) {
      throw new Error('grader collusion rejected: candidate and grader must be independent actors');
    }
    if (!input.holdout || input.holdout.commitment !== holdoutCommitment(input.holdout.reveal)) {
      throw new Error('holdout commitment mismatch');
    }
    if (finite(input.holdout.committedAt, Infinity) > finite(input.startedAt, -Infinity)) {
      throw new Error('holdout must be committed before experiment start');
    }
    const baseline = mean(input.baselineScores);
    const candidate = mean(input.candidateScores);
    if (baseline == null || candidate == null || input.baselineScores.length !== input.candidateScores.length) {
      throw new Error('paired baseline and candidate scores are required');
    }
    const gain = candidate - baseline;
    const falsifiers = (input.falsifiers || []).filter(item => item && item.failed);
    const admission = this._admitExperimentClaim(input);
    const promoted = admission.result.verdict === 'admitted';
    const experiment = {
      experimentId: input.experimentId || `experiment:${hash(input.holdout.commitment).slice(7, 23)}`,
      candidatePolicyHash: assertBoundedText(input.candidatePolicyHash, 'candidate policy hash'),
      parentPolicyHash: input.parentPolicyHash || null,
      candidateActor: input.candidateActor,
      graderActor: input.graderActor,
      holdoutCommitment: input.holdout.commitment,
      anchorCount: anchors.count,
      baseline,
      candidate,
      gain,
      falsifiers,
      promoted,
      claimId: admission.claimId,
      claimRecordHash: admission.record.recordHash,
    };
    const evaluated = this.append('experiment-evaluated', experiment);
    if (promoted) {
      this.append('policy-promoted', {
        policyHash: experiment.candidatePolicyHash,
        parentPolicyHash: experiment.parentPolicyHash,
        experimentRecordHash: evaluated.recordHash,
        claimId: admission.claimId,
        claimRecordHash: admission.record.recordHash,
      });
    } else {
      this.append('policy-revoked', {
        policyHash: experiment.candidatePolicyHash,
        rollbackTarget: experiment.parentPolicyHash,
        reason: falsifiers.length ? 'falsifier-triggered' : 'recombination-baseline-not-beaten',
        experimentRecordHash: evaluated.recordHash,
        claimId: admission.claimId,
        claimRecordHash: admission.record.recordHash,
      });
      if (input.cellId && this.projection().cells.has(input.cellId)) {
        this.append('apoptosis', { cellId: input.cellId, reason: 'regressing-instrument', evidenceRefs: [evaluated.recordHash] });
      }
    }
    return experiment;
  }

  autonomyTurn(options = {}) {
    const now = finite(options.now, this.clock());
    const deadline = finite(options.deadline, now);
    if (options.operatorPresent) return { continue: false, reason: 'operator-returned' };
    if (now >= deadline) return { continue: false, reason: 'deadline-reached' };
    this.ensureBootstrap();
    const state = this.projection();
    const candidates = [...state.cells.values()]
      .filter(cell => !['quarantined', 'failed', 'exhausted'].includes(cell.state))
      .sort((a, b) => (state.gradients.get(b.gradientId)?.magnitude || 0) - (state.gradients.get(a.gradientId)?.magnitude || 0));
    const cell = candidates[0];
    if (!cell) return { continue: true, reason: 'discover', directive: 'Recruit from unresolved contradictions and proposals.' };
    const gradient = state.gradients.get(cell.gradientId);
    return {
      continue: true,
      reason: 'ecological-work-remains',
      cell,
      directive: `${cell.caste}: ${gradient?.statement || cell.purpose}`,
      remainingMs: deadline - now,
    };
  }

  snapshot() {
    const state = this.projection();
    const cells = [...state.cells.values()];
    const active = cells.filter(cell => !['quarantined', 'failed', 'exhausted'].includes(cell.state));
    const casteCounts = Object.fromEntries(Object.keys(CASTES).map(caste => [caste, active.filter(cell => cell.caste === caste).length]));
    const niches = [...new Set(active.map(cell => cell.niche))];
    const gradients = [...state.gradients.values()].sort((a, b) => b.magnitude - a.magnitude).slice(0, 12);
    const totalBudget = active.reduce((sum, cell) => sum + finite(cell.budget.tokens), 0);
    const usedBudget = active.reduce((sum, cell) => sum + finite(cell.used?.tokens), 0);
    return {
      schema: 1,
      state: active.length ? 'metabolizing' : 'dormant',
      counts: {
        active: active.length,
        totalCells: cells.length,
        gradients: state.gradients.size,
        niches: niches.length,
        quarantined: cells.filter(cell => cell.state === 'quarantined').length,
        failed: cells.filter(cell => cell.state === 'failed').length,
        experiments: state.experiments.length,
        claims: state.claims.size,
        admittedClaims: [...state.claims.values()].filter(claim => claim.state === 'admitted').length,
        rejectedClaims: [...state.claims.values()].filter(claim => claim.state === 'rejected').length,
      },
      casteCounts,
      niches,
      gradients,
      metabolism: { usedTokens: usedBudget, totalTokens: totalBudget, utilization: totalBudget ? usedBudget / totalBudget : 0 },
      cells: active.slice(0, this.limits.maxCells).map(cell => ({
        cellId: cell.cellId,
        parentCellId: cell.parentCellId,
        caste: cell.caste,
        niche: cell.niche,
        state: cell.state,
        model: cell.route.model,
        used: cell.used,
        budget: cell.budget,
      })),
      deaths: state.deaths.slice(-8),
      claims: [...state.claims.values()].slice(-8),
      latestEvents: state.events.slice(-this.limits.maxEventsInSnapshot).map(record => ({
        seq: record.seq,
        kind: record.kind,
        recordHash: record.recordHash,
        ts: record.ts,
      })),
      ledger: {
        records: state.totalRecords,
        head: state.events.at(-1)?.recordHash || null,
        projectionTruncated: state.projectionTruncated,
        bytes: fs.existsSync(this.ledgerPath) ? fs.statSync(this.ledgerPath).size : 0,
      },
    };
  }
}

module.exports = {
  XenobioticEcology,
  CASTES,
  DEFAULT_LIMITS,
  canonical,
  hash,
  gradientFromSignal,
  routeCaste,
  validateEvidenceAnchors,
  holdoutCommitment,
};
