'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  XenobioticEcology,
  CASTES,
  gradientFromSignal,
  hash,
  holdoutCommitment,
  routeCaste,
  validateEvidenceAnchors,
} = require('../xenobiotic-ecology.cjs');

let now = Date.parse('2026-07-28T21:00:00Z');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-xeno-ecology-'));
const ecology = new XenobioticEcology({
  memDir: temp,
  clock: () => now++,
  limits: { maxCells: 12, maxPerNiche: 4, maxRecruitPerCycle: 6, maxProjectionRecords: 128 },
});

try {
  // Empty ecology bootstraps an instrument, never an unsupported conclusion.
  const bootstrap = ecology.ensureBootstrap();
  assert.equal(bootstrap.created, true);
  assert.equal(bootstrap.cell.caste, 'instrument-builder');
  assert.equal(ecology.ensureBootstrap().created, false, 'bootstrap is idempotent');

  // Contradictions become bounded gradients and recruit diverse, routed castes.
  const gradient = gradientFromSignal({
    statement: 'Memory evidence and source evidence disagree',
    kind: 'contradiction',
    niche: 'memory',
    confidenceA: 0.72,
    confidenceB: 0.68,
    impact: 0.9,
  }, now);
  assert(gradient.magnitude > 0 && gradient.magnitude <= 1);
  const recruited = ecology.recruit({
    contradictions: [
      {
        statement: 'Memory evidence and source evidence disagree',
        kind: 'contradiction',
        niche: 'memory',
        confidenceA: 0.72,
        confidenceB: 0.68,
        impact: 0.9,
      },
      {
        statement: 'The new instrument lacks an independent benchmark',
        kind: 'instrument-gap',
        niche: 'verification',
        impact: 0.95,
      },
    ],
  });
  assert(recruited.cells.some(cell => cell.caste === 'pathogen'));
  assert(recruited.cells.some(cell => cell.caste === 'instrument-builder'));
  assert(new Set(recruited.cells.map(cell => cell.niche)).size >= 2, 'niche diversity survives recruitment');
  assert(recruited.telemetry.durationMs >= 0);
  assert(recruited.telemetry.inputBytes > 0);
  assert(recruited.telemetry.ledgerBytes > 0);

  // Model assignment follows failure surface.
  assert.equal(routeCaste('forager').model, 'gpt-5.5');
  assert.equal(routeCaste('pathogen').model, 'gpt-5.6-terra');
  assert.equal(routeCaste('symbiont').model, 'gpt-5.6-luna');
  assert.equal(CASTES.undertaker.mode, 'build');

  // Metabolism is hard-bounded and overflow triggers append-only apoptosis.
  const forager = recruited.cells.find(cell => cell.caste === 'forager');
  const metabolic = ecology.metabolize(forager.cellId, { tokens: forager.budget.tokens + 1 });
  assert.equal(metabolic.exhausted, true);
  assert.equal(ecology.projection().cells.get(forager.cellId).state, 'quarantined');

  // A failed organ routes to a different fallback caste without deleting spoor.
  const pathogen = recruited.cells.find(cell => cell.caste === 'pathogen');
  const recovery = ecology.recordFailure(pathogen.cellId, 'Boundary grader unavailable', { organ: 'boundary', recoverable: true });
  assert.equal(recovery.recovered, true);
  assert.notEqual(recovery.fallback.caste, pathogen.caste);
  assert.equal(recovery.fallback.parentCellId, pathogen.cellId);

  // Evidence anchors reject forgery, cycles, and grader collusion.
  const anchorA = { content: 'source A', hash: hash('source A'), parents: [] };
  const anchorB = { content: 'source B', hash: hash('source B'), parents: [anchorA.hash] };
  assert.equal(validateEvidenceAnchors([anchorA, anchorB]).count, 2);
  assert.throws(() => validateEvidenceAnchors([{ ...anchorA, hash: hash('forged') }]), /forged anchor/);
  const circularA = { ...anchorA, parents: [anchorB.hash] };
  assert.throws(() => validateEvidenceAnchors([circularA, anchorB]), /circular citation/);

  const reveal = { cases: [{ input: 1, expected: 2 }, { input: 2, expected: 4 }], salt: 'sealed-before-trial' };
  const commitment = holdoutCommitment(reveal);
  assert.throws(() => ecology.evaluateExperiment({
    candidatePolicyHash: hash('candidate-collusion'),
    parentPolicyHash: hash('parent'),
    candidateActor: 'same',
    graderActor: 'same',
    holdout: { commitment, reveal, committedAt: 10 },
    startedAt: 20,
    baselineScores: [0.5, 0.5],
    candidateScores: [0.8, 0.8],
    anchors: [anchorA],
  }), /grader collusion/);

  // The Wall admits novelty only when a precommitted independent holdout beats baseline.
  const promoted = ecology.evaluateExperiment({
    experimentId: 'experiment:novel',
    candidatePolicyHash: hash('candidate-novel'),
    parentPolicyHash: hash('parent'),
    candidateActor: 'instrument-builder-1',
    graderActor: 'pathogen-1',
    holdout: { commitment, reveal, committedAt: 10 },
    startedAt: 20,
    baselineScores: [0.5, 0.55],
    candidateScores: [0.82, 0.8],
    falsifiers: [],
    anchors: [anchorA, anchorB],
  });
  assert.equal(promoted.promoted, true);

  // Regression provokes apoptosis and a rollback target, preserving the failed record.
  const regressingCell = recruited.cells.find(cell => cell.caste === 'instrument-builder');
  const rejected = ecology.evaluateExperiment({
    experimentId: 'experiment:regression',
    candidatePolicyHash: hash('candidate-regression'),
    parentPolicyHash: hash('stable-parent'),
    candidateActor: 'instrument-builder-2',
    graderActor: 'pathogen-2',
    cellId: regressingCell.cellId,
    holdout: { commitment, reveal, committedAt: 10 },
    startedAt: 20,
    baselineScores: [0.8, 0.82],
    candidateScores: [0.7, 0.69],
    falsifiers: [],
    anchors: [anchorA],
  });
  assert.equal(rejected.promoted, false);
  const rollback = ecology.records().find(record => record.kind === 'policy-revoked' && record.payload.policyHash === hash('candidate-regression'));
  assert.equal(rollback.payload.rollbackTarget, hash('stable-parent'));
  assert.equal(ecology.projection().cells.get(regressingCell.cellId).state, 'quarantined');

  // Autonomy continues while time remains, but operator return and deadline are absolute.
  const activeTurn = ecology.autonomyTurn({ deadline: now + 60_000, now, operatorPresent: false });
  assert.equal(activeTurn.continue, true);
  assert(activeTurn.directive);
  assert.deepEqual(ecology.autonomyTurn({ deadline: now + 60_000, now, operatorPresent: true }), { continue: false, reason: 'operator-returned' });
  assert.deepEqual(ecology.autonomyTurn({ deadline: now, now, operatorPresent: false }), { continue: false, reason: 'deadline-reached' });

  // Population and signal overflow backpressure instead of unbounded reproduction.
  const bounded = new XenobioticEcology({
    memDir: path.join(temp, 'bounded'),
    clock: () => now++,
    limits: { maxCells: 2, maxPerNiche: 1, maxRecruitPerCycle: 2, maxSignalsPerCycle: 2 },
  });
  bounded.ensureBootstrap();
  const overflow = bounded.recruit({ contradictions: [{ statement: 'Another unknown', niche: 'origin', kind: 'unknown' }] });
  assert(overflow.snapshot.ledger.records > 0);
  assert(overflow.snapshot.counts.active <= 2);
  assert.throws(() => bounded.recruit({ contradictions: [
    { statement: 'one' }, { statement: 'two' }, { statement: 'three' },
  ] }), /signal overflow/);

  // Authority material never enters the ledger.
  assert.throws(() => ecology.append('unsafe', { token: 'do-not-store' }), /authority leakage/);

  // A byte edit breaks the hash chain instead of becoming accepted history.
  const tamperDir = path.join(temp, 'tamper');
  const tampered = new XenobioticEcology({ memDir: tamperDir, clock: () => now++ });
  tampered.ensureBootstrap();
  const ledger = path.join(tamperDir, 'xenobiotic-ecology.ndjson');
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('empty-bootstrap', 'empty-bootstrapped'), 'utf8');
  assert.throws(() => tampered.verifyLedger(), /record hash mismatch/);

  const snapshot = ecology.snapshot();
  assert(snapshot.counts.gradients >= 3);
  assert(snapshot.casteCounts.pathogen >= 0);
  assert(snapshot.ledger.head.startsWith('sha256:'));
  assert(snapshot.latestEvents.length <= 12);
  assert.equal(ecology.verifyLedger().valid, true);

  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'fleethost.mjs'), 'utf8');
  const uiSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(hostSource.includes("send('ecology'"), 'sidecar broadcasts the bounded ecology projection');
  assert(hostSource.includes('_ecologyOrgan.recruit({ proposals })'), 'qualified proposals recruit through the ecology');
  assert(uiSource.includes('data-tab="ecology"'), 'live UI exposes an ecology tab');
  assert(uiSource.includes('function renderEcology(payload)'), 'live UI renders ecology events');

  console.log(JSON.stringify({
    ok: true,
    records: snapshot.ledger.records,
    cells: snapshot.counts.totalCells,
    gradients: snapshot.counts.gradients,
    niches: snapshot.counts.niches,
    quarantined: snapshot.counts.quarantined,
  }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
