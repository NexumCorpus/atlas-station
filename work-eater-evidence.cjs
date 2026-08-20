'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_LINE_BYTES = 64 * 1024;
const MAX_RECORDS = 20_000;
const SECRET_KEY = /^(token|secret|password|api[-_]?key|authorization|cookie)$/i;
const RULES = Object.freeze([
  ['quota-exhaustion', /usage limit|quota|credits|rate limit/i],
  ['timeout-starvation', /timeout|timed out|deadline|starv/i],
  ['provider-access', /\b403\b|auth|subscription|provider|spawn eperm/i],
  ['duplicate-autonomy', /duplicate|repeated|dream pulse|already queued/i],
  ['validation-failure', /test|syntax|validation|acceptance|gate/i],
  ['backpressure', /overflow|backpressure|budget-exceeded|exhausted/i],
]);
const STOP = new Set('about after again against being could every first from have into itself more must only other should their there these they this through under until where which while with would'.split(' '));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8');
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function assertNoSecrets(value, trail = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\s._-]/gu, '');
    if (SECRET_KEY.test(normalizedKey)) throw new Error(`negative evidence contains secret-shaped field at ${[...trail, key].join('.')}`);
    assertNoSecrets(child, [...trail, key]);
  }
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > MAX_RECORDS + 1) throw new Error(`${path.basename(file)} exceeds ${MAX_RECORDS} records`);
  return lines.flatMap((raw, index) => {
    if (!raw.trim()) return [];
    if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) throw new Error(`${path.basename(file)}:${index + 1} exceeds ${MAX_LINE_BYTES} bytes`);
    let value;
    try { value = JSON.parse(raw); } catch (error) { throw new Error(`${path.basename(file)}:${index + 1}: ${error.message}`); }
    assertNoSecrets(value);
    return [{ value, raw, line: index + 1, source: path.basename(file), rawHash: hash(raw) }];
  });
}

function costUnits(cost) {
  if (typeof cost === 'number' && Number.isFinite(cost)) return Math.max(0, cost);
  if (typeof cost === 'string') {
    const parsed = Number(cost.replace(/[^0-9.+-]/g, ''));
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  if (!cost || typeof cost !== 'object') return 0;
  return Math.max(0,
    Number(cost.tokens || 0) / 1000 + Number(cost.wallMs || 0) / 60_000 +
    Number(cost.toolCalls || 0) + Number(cost.mutations || 0) * 10
  );
}

function adapt(row) {
  const x = row.value;
  let admitted = false;
  let outcome = '';
  let statement = '';
  let cost = 0;
  if (row.source === 'runs.jsonl' && x.state === 'failed') {
    [admitted, outcome, statement, cost] = [true, 'failed-run', x.summary || x.task || 'failed run', costUnits(x.cost)];
  } else if (row.source === 'proposals.ndjson' && ['deferred', 'rejected'].includes(x.state)) {
    [admitted, outcome, statement] = [true, `${x.state}-proposal`, [x.cause, x.blocker, x.description].filter(Boolean).join(' ')];
  } else if (row.source === 'outcomes.ndjson' && ['bad', 'partial'].includes(x.rating)) {
    [admitted, outcome, statement] = [true, `${x.rating}-outcome`, [x.notes, canonical(x.causalChain || [])].filter(Boolean).join(' ')];
  } else if (row.source === 'xenobiotic-ecology.ndjson' && ['cell-failure', 'policy-revoked', 'apoptosis', 'recruitment-backpressure'].includes(x.kind)) {
    [admitted, outcome, statement] = [true, x.kind, canonical(x.payload || {})];
    cost = costUnits(x.payload?.used);
  }
  if (!admitted) return null;
  return {
    evidenceId: hash({ source: row.source, line: row.line, rawHash: row.rawHash }),
    source: row.source,
    line: row.line,
    rawHash: row.rawHash,
    raw: row.raw,
    observedAt: x.ts || null,
    outcome,
    statement: String(statement).slice(0, MAX_LINE_BYTES),
    costUnits: cost,
    authority: 'observe',
  };
}

function collectEvidence(memDir) {
  const names = ['runs.jsonl', 'proposals.ndjson', 'outcomes.ndjson', 'xenobiotic-ecology.ndjson'];
  return names.flatMap(name => readRows(path.join(memDir, name)).map(adapt).filter(Boolean));
}

function signatureOf(evidence) {
  const matched = RULES.find(([, pattern]) => pattern.test(evidence.statement));
  if (matched) return matched[0];
  const words = evidence.statement.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(word => word.length > 4 && !STOP.has(word));
  const stable = [...new Set(words)].sort().slice(0, 4);
  return stable.length ? `lex:${stable.join('-')}` : `opaque:${evidence.outcome}`;
}

function rankBurdens(evidence, now = Date.now()) {
  const unique = new Map();
  for (const item of evidence) {
    if (item.rawHash !== hash(item.raw)) throw new Error(`forged evidence hash at ${item.source}:${item.line}`);
    unique.set(`${item.source}:${item.rawHash}`, item);
  }
  const groups = new Map();
  for (const item of unique.values()) {
    const signature = signatureOf(item);
    const group = groups.get(signature) || { signature, evidence: [], sources: new Set(), explicitCost: 0, newest: 0 };
    group.evidence.push(item);
    group.sources.add(item.source);
    group.explicitCost += item.costUnits;
    const ts = Date.parse(item.observedAt || '');
    if (Number.isFinite(ts)) group.newest = Math.max(group.newest, ts);
    groups.set(signature, group);
  }
  return [...groups.values()].map(group => {
    const recency = group.newest ? Math.max(0, Math.min(1, 1 - ((now - group.newest) / 2_592_000_000))) : 0;
    const components = { frequency: group.evidence.length, sourceDiversity: group.sources.size, explicitCost: Number(group.explicitCost.toFixed(3)), recency: Number(recency.toFixed(3)) };
    const score = components.frequency * 10 + components.sourceDiversity * 7 + Math.min(100, components.explicitCost) + components.recency * 10;
    return { ...group, sources: [...group.sources].sort(), components, score: Number(score.toFixed(3)) };
  }).sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));
}

module.exports = { MAX_RECORDS, canonical, hash, collectEvidence, rankBurdens, signatureOf, assertNoSecrets };
