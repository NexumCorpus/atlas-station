'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LEDGER = process.env.ATLAS_SPIRAL_LEDGER || 'E:\\station\\spiral.jsonl';
const STATION = process.env.STATION_CLI || 'E:\\station\\station.py';
const ALLOWED_SUBSYSTEMS = new Set([
  'conversation', 'autonomy', 'memory', 'provider', 'fleet', 'ui', 'wing',
  'grading', 'mission', 'governance', 'efficiency', 'economy',
]);

function clean(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry && entry.kind === 'spiral' && entry.organism === 'atlas-hermes');
}

function validate(input, prior) {
  const subsystem = clean(input.subsystem).toLowerCase();
  const capability = clean(input.capability).toLowerCase();
  const summary = clean(input.summary);
  const falsifier = clean(input.falsifier);
  const killCondition = clean(input.killCondition);
  const evidence = Array.isArray(input.evidence) ? input.evidence.map(clean).filter(Boolean) : [];
  const measure = input.measure && typeof input.measure === 'object' ? input.measure : {};
  const measureName = clean(measure.name);
  const before = measure.before;
  const after = measure.after;
  const continuationOf = clean(input.continuationOf);

  if (!ALLOWED_SUBSYSTEMS.has(subsystem)) throw new Error(`unknown subsystem: ${subsystem || '(empty)'}`);
  if (capability.length < 5) throw new Error('capability must name the concrete new vector');
  if (summary.length < 12) throw new Error('summary must describe the concrete change');
  if (falsifier.length < 8 || killCondition.length < 8) throw new Error('falsifier and killCondition are required');
  if (evidence.length < 1) throw new Error('at least one evidence reference is required');
  if (!measureName || before === undefined || after === undefined || JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error('measure requires a name and a real before/after change');
  }

  const noveltyKey = `${subsystem}:${capability}`;
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const duplicate = prior.slice(-32).find((entry) =>
    entry.noveltyKey === noveltyKey || entry.evidenceHash === evidenceHash
  );
  if (duplicate && !continuationOf) {
    throw new Error(`duplicate spiral vector/evidence; record a continuationOf=${duplicate.id} instead of a new spiral`);
  }
  if (continuationOf && !prior.some((entry) => entry.id === continuationOf)) {
    throw new Error(`continuationOf does not identify an existing spiral: ${continuationOf}`);
  }

  return {
    subsystem, capability, summary, falsifier, killCondition, evidence,
    measure: { name: measureName, before, after },
    noveltyKey, evidenceHash, continuationOf: continuationOf || null,
    countsAsNewVector: !continuationOf,
  };
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('stdin must be one JSON object'); }
  const prior = loadLedger();
  const valid = validate(input, prior);
  const identity = crypto.createHash('sha256')
    .update(JSON.stringify({ ...valid, evidenceHash: valid.evidenceHash }))
    .digest('hex').slice(0, 16);
  const record = {
    kind: 'spiral',
    organism: 'atlas-hermes',
    id: `SPIRAL-${identity}`,
    ...valid,
  };
  const sealed = spawnSync(process.env.PYTHON_BIN || 'python', [STATION, 'seal', LEDGER], {
    input: JSON.stringify(record),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (sealed.error || sealed.status !== 0) {
    throw new Error(clean(sealed.stderr || sealed.stdout || sealed.error?.message || 'station seal failed'));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, record, station: clean(sealed.stdout) }, null, 2)}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`spiral rejected: ${error.message}\n`);
  process.exitCode = 1;
}
