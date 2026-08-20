'use strict';

const fs = require('fs');
const path = require('path');
const { canonical, hash, rankBurdens, assertNoSecrets } = require('./work-eater-evidence.cjs');
const { XenobioticEcology } = require('./xenobiotic-ecology.cjs');
const { appendCrashSafe, recoverPending } = require('./work-eater-store.cjs');

const LEDGER = 'work-eater.ndjson';
const LOCK_STALE_MS = 30_000;
const MAX_CONTRACTS = 8;

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function contractFor(burden) {
  const refs = burden.evidence.map(item => ({ evidenceId: item.evidenceId, source: item.source, line: item.line, rawHash: item.rawHash, outcome: item.outcome, observedAt: item.observedAt }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.rawHash.localeCompare(b.rawHash));
  const body = {
    schema: 1,
    signature: burden.signature,
    objective: `Make recurrence '${burden.signature}' structurally impossible at its source.`,
    score: burden.score,
    scoreComponents: burden.components,
    sources: burden.sources,
    baselineOccurrences: refs.length,
    evidenceRoot: hash(refs),
    evidenceRefs: refs,
    authority: { level: 'propose', mutationAllowed: false, promotionAllowed: false },
    prohibitedSubstitutes: ['retry the same action', 'run the same action faster', 'hide or relabel the outcome', 'shift equivalent cost to another organ'],
    counterfactualWitness: {
      baseline: `${refs.length} admitted occurrences across ${burden.sources.length} source ledgers`,
      candidate: 'zero recurrence on a precommitted eligible-event holdout',
      conservation: 'no equal-or-greater displaced token, wall-time, tool-call, mutation, or operator cost',
    },
    falsifiers: ['any eligible holdout recurrence', 'candidate and grader share identity', 'holdout committed after work starts', 'cost moves instead of disappearing'],
    killCondition: 'Revoke on one recurrence, one forged evidence ref, or any displaced cost at or above the erased burden.',
  };
  const identity = {
    schema: body.schema,
    signature: body.signature,
    objective: body.objective,
    authority: body.authority,
    prohibitedSubstitutes: body.prohibitedSubstitutes,
    killCondition: body.killCondition,
  };
  return { ...body, contractHash: hash(identity) };
}

class WorkEater {
  constructor(options = {}) {
    this.memDir = path.resolve(options.memDir || path.join(__dirname, 'memory'));
    this.ledgerPath = path.join(this.memDir, LEDGER);
    this.lockPath = `${this.ledgerPath}.lock`;
    this.pendingPath = `${this.ledgerPath}.pending`;
    this.clock = options.clock || (() => Date.now());
    this.actor = options.actor || 'ATLAS/Hermes';
    fs.mkdirSync(this.memDir, { recursive: true });
  }

  records() {
    if (!fs.existsSync(this.ledgerPath)) return [];
    const records = [];
    let previous = null;
    for (const [index, line] of fs.readFileSync(this.ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
      let record;
      try { record = JSON.parse(line); } catch (error) { throw new Error(`work-eater ledger invalid JSON at line ${index + 1}: ${error.message}`); }
      const body = { ...record };
      delete body.recordHash;
      if (record.seq !== index + 1 || record.prevRecordHash !== previous || record.recordHash !== hash(body)) throw new Error(`work-eater ledger chain mismatch at seq ${record.seq || index + 1}`);
      previous = record.recordHash;
      records.push(record);
    }
    return records;
  }

  _acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: this.clock() }), 'utf8');
        fs.fsyncSync(fd);
        return fd;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = {};
        try { owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch {}
        const ownerPid = Number(owner.pid);
        if (alive(ownerPid) || (!Number.isInteger(ownerPid) && this.clock() - Number(owner.createdAt || 0) <= LOCK_STALE_MS)) throw new Error(`work-eater writer busy: pid=${owner.pid || 'unknown'}`);
        try { fs.renameSync(this.lockPath, `${this.lockPath}.stale-${this.clock()}`); } catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; }
      }
    }
    throw new Error('work-eater writer lock recovery failed');
  }

  _withLock(fn) {
    const fd = this._acquire();
    try { recoverPending(this.ledgerPath, this.pendingPath, hash); return fn(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(this.lockPath); } catch {} }
  }

  _append(kind, payload) {
    assertNoSecrets(payload);
    const records = this.records();
    const body = { schema: 1, seq: records.length + 1, ts: new Date(this.clock()).toISOString(), kind, actor: this.actor, prevRecordHash: records.at(-1)?.recordHash || null, payload };
    const record = { ...body, recordHash: hash(body) };
    appendCrashSafe(this.ledgerPath, this.pendingPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  plan(evidence, options = {}) {
    if (!Array.isArray(evidence)) throw new TypeError('negative evidence must be an array');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('work-eater options must be an object');
    const limitValue = options.limit === undefined ? 3 : Number(options.limit);
    if (!Number.isFinite(limitValue)) throw new TypeError('limit must be a finite number');
    const now = options.now === undefined ? this.clock() : Number(options.now), minimum = options.minOccurrences === undefined ? 2 : Number(options.minOccurrences);
    if (!Number.isFinite(now) || !Number.isFinite(minimum)) throw new TypeError('now and minOccurrences must be finite numbers');
    const limit = Math.max(1, Math.min(MAX_CONTRACTS, Math.trunc(limitValue)));
    return rankBurdens(evidence, now).filter(burden => burden.evidence.length >= Math.max(1, Math.trunc(minimum))).slice(0, limit).map(contractFor);
  }

  sweep(evidence, options = {}) {
    const contracts = this.plan(evidence, options);
    if (options.dryRun) return { contracts, created: [], dryRun: true, ledger: this.verifyLedger() };
    return this._withLock(() => {
      const existing = new Set(this.records().filter(row => row.kind === 'contract-born').map(row => row.payload.contract.contractHash));
      const created = [];
      for (const contract of contracts) {
        if (existing.has(contract.contractHash)) continue;
        const record = this._append('contract-born', { contract });
        created.push({ contract, recordHash: record.recordHash });
        existing.add(contract.contractHash);
      }
      return { contracts, created, dryRun: false, ledger: this.verifyLedger() };
    });
  }

  linkEcology(contractHash, ecology) {
    return this._withLock(() => {
      const records = this.records();
      if (!records.some(row => row.kind === 'contract-born' && row.payload.contract.contractHash === contractHash)) throw new Error(`unknown abolition contract: ${contractHash}`);
      const live = new XenobioticEcology({ memDir: this.memDir });
      const projection = live.projection();
      const ecologyHead = live.verifyLedger().head;
      const cells = [...new Set((ecology.cellIds || []).map(String))].sort();
      const gradients = [...new Set((ecology.gradientIds || []).map(String))].sort();
      if (ecology.ecologyHead !== ecologyHead) throw new Error('ecology head does not match live ledger');
      if (cells.some(cellId => !projection.cells.has(cellId))) throw new Error('ecology link contains unknown cell');
      if (gradients.some(gradientId => !projection.gradients.has(gradientId))) throw new Error('ecology link contains unknown gradient');
      const prior = records.find(row => row.kind === 'ecology-linked' && row.payload.contractHash === contractHash && canonical(row.payload.cellIds) === canonical(cells));
      if (prior) return prior;
      return this._append('ecology-linked', { contractHash, cellIds: cells, gradientIds: gradients, ecologyHead });
    });
  }

  recordExtinction(input) {
    return this._withLock(() => {
      const records = this.records();
      if (!records.some(row => row.kind === 'contract-born' && row.payload.contract.contractHash === input.contractHash)) throw new Error(`unknown abolition contract: ${input.contractHash}`);
      const ecologyRecords = new XenobioticEcology({ memDir: this.memDir }).records();
      const evaluated = ecologyRecords.find(row => row.kind === 'experiment-evaluated' && row.recordHash === input.experimentRecordHash);
      if (!evaluated) throw new Error('extinction requires a live ecology experiment record');
      const experiment = evaluated.payload || {};
      const promoted = ecologyRecords.some(row => row.kind === 'policy-promoted' && row.payload?.experimentRecordHash === evaluated.recordHash && row.payload?.policyHash === input.contractHash);
      if (experiment.candidatePolicyHash !== input.contractHash) throw new Error('experiment candidate does not match abolition contract');
      const actorsIndependent = experiment.candidateActor && experiment.graderActor && experiment.candidateActor !== experiment.graderActor;
      const extinct = experiment.promoted === true && promoted && actorsIndependent && Number(input.candidateOccurrences) === 0 && Number(input.displacedCost || 0) <= 0;
      const kind = extinct ? 'burden-extinct' : 'contract-rollback';
      const payload = {
        contractHash: input.contractHash,
        experimentId: experiment.experimentId || null,
        experimentRecordHash: evaluated.recordHash,
        baselineOccurrences: Number(input.baselineOccurrences),
        candidateOccurrences: Number(input.candidateOccurrences),
        displacedCost: Number(input.displacedCost || 0),
        actorsIndependent: Boolean(actorsIndependent),
        reason: extinct ? 'independent-zero-recurrence-holdout' : 'extinction-proof-failed',
      };
      const prior = records.find(row => row.kind === kind && canonical(row.payload) === canonical(payload));
      return prior || this._append(kind, payload);
    });
  }

  verifyLedger() {
    const records = this.records();
    return { valid: true, records: records.length, head: records.at(-1)?.recordHash || null };
  }

  snapshot() {
    const records = this.records();
    const born = records.filter(row => row.kind === 'contract-born');
    const extinct = new Set(records.filter(row => row.kind === 'burden-extinct').map(row => row.payload.contractHash));
    return { schema: 1, state: born.length ? 'feeding' : 'dormant', contracts: born.length, extinct: extinct.size, active: born.filter(row => !extinct.has(row.payload.contract.contractHash)).slice(-8).map(row => row.payload.contract), ledger: this.verifyLedger() };
  }
}

module.exports = { WorkEater, contractFor, LEDGER };
