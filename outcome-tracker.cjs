'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTCOMES_FILE = (dir) => path.join(dir, 'outcomes.ndjson');
const DISPOSITIONS_FILE = (dir) => path.join(dir, 'outcome-dispositions.ndjson');

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function parseFailureMode(stderr) {
  const text = (stderr || '').toLowerCase();
  if (text.includes('merge conflict') || text.includes('conflict in') || text.includes('automatic merge failed')) return 'merge_conflict';
  if (text.includes('syntaxerror') || text.includes('error:') || text.includes('failed to')) return 'logic_error';
  if (text.includes('permission denied') || text.includes('enoent') || text.includes('eacces')) return 'environment';
  if (/max[-_ ]?turns|tool[-_ ]round|exhausted|turn bound/.test(text)) return 'turn_exhaustion';
  return 'unknown';
}

// rating: 'good' | 'partial' | 'bad' | 1-5
// causalChain: [{ step, assumption, violated, evidence }] — optional, for temporal credit assignment
function rateOutcome(agentId, rating, notes, memDir, failureMode, causalChain) {
  const normalized = typeof rating === 'number'
    ? (rating >= 4 ? 'good' : rating >= 2 ? 'partial' : 'bad')
    : String(rating).toLowerCase();
  const entry = { agentId, rating: normalized, notes: notes || '', ts: new Date().toISOString() };
  if (failureMode) entry.failureMode = failureMode;
  if (causalChain) entry.causalChain = causalChain;
  fs.appendFileSync(OUTCOMES_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function getOutcomes(memDir, limit) {
  return readNdjson(OUTCOMES_FILE(memDir)).slice(-(limit || 50));
}

function getOutcomeDispositions(memDir) {
  return readNdjson(DISPOSITIONS_FILE(memDir));
}

function verifyDispositionLedger(memDir) {
  const records = getOutcomeDispositions(memDir);
  let previousHash = null;
  const errors = [];
  records.forEach((record, index) => {
    const { hash, ...body } = record;
    if (body.seq !== index + 1) errors.push({ index, reason: 'sequence' });
    if (body.previousHash !== previousHash) errors.push({ index, reason: 'previousHash' });
    if (digest(body) !== hash) errors.push({ index, reason: 'hash' });
    previousHash = hash;
  });
  return { valid: errors.length === 0, records, errors, head: previousHash };
}

function dispositionOutcome(agentId, disposition, reason, evidence, memDir) {
  if (!['retired', 'superseded'].includes(disposition)) throw new Error('unsupported outcome disposition');
  if (!reason || String(reason).trim().length < 20) throw new Error('disposition reason requires specific evidence');
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error('disposition evidence is required');
  const original = getOutcomes(memDir, 100000).find(entry => entry.agentId === agentId);
  if (!original) throw new Error(`outcome not found: ${agentId}`);
  const originalHash = digest(original);
  const ledger = verifyDispositionLedger(memDir);
  if (!ledger.valid) throw new Error('outcome disposition ledger is invalid');
  const duplicate = ledger.records.find(entry =>
    entry.agentId === agentId && entry.originalHash === originalHash && entry.disposition === disposition
  );
  if (duplicate) return duplicate;
  const body = {
    seq: ledger.records.length + 1,
    agentId,
    originalHash,
    originalRating: original.rating,
    originalFailureMode: original.failureMode || null,
    disposition,
    reason: String(reason),
    evidence,
    previousHash: ledger.head,
    ts: new Date().toISOString(),
  };
  const entry = { ...body, hash: digest(body) };
  fs.appendFileSync(DISPOSITIONS_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function outcomeStats(memDir) {
  const outcomes = getOutcomes(memDir, 100);
  if (!outcomes.length) return { total: 0, good: 0, partial: 0, bad: 0, successRate: null };
  const counts = { good: 0, partial: 0, bad: 0 };
  for (const o of outcomes) counts[o.rating] = (counts[o.rating] || 0) + 1;
  return {
    total: outcomes.length,
    ...counts,
    successRate: Math.round((counts.good / outcomes.length) * 100) + '%',
    recent: outcomes.slice(-5),
  };
}

// Returns a ranked list of violated assumptions across all outcomes that have causalChain data.
// Useful for identifying systemic failure patterns: what beliefs does ATLAS keep getting wrong?
function failureProfile(memDir, limit) {
  const outcomes = getOutcomes(memDir, limit || 100);
  const withChain = outcomes.filter(o => Array.isArray(o.causalChain) && o.causalChain.length);
  if (!withChain.length) return [];

  // Flatten all chain items across entries, keeping parent agentId for examples
  const violated = [];
  for (const o of withChain) {
    for (const item of o.causalChain) {
      if (item.violated === true) {
        violated.push({ agentId: o.agentId, assumption: item.assumption, evidence: item.evidence });
      }
    }
  }

  // Group by assumption string
  const grouped = {};
  for (const v of violated) {
    if (!grouped[v.assumption]) grouped[v.assumption] = { count: 0, examples: [] };
    grouped[v.assumption].count++;
    if (grouped[v.assumption].examples.length < 3) {
      grouped[v.assumption].examples.push({ agentId: v.agentId, evidence: v.evidence });
    }
  }

  return Object.entries(grouped)
    .map(([assumption, data]) => ({ assumption, count: data.count, examples: data.examples }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  rateOutcome,
  getOutcomes,
  outcomeStats,
  parseFailureMode,
  failureProfile,
  dispositionOutcome,
  getOutcomeDispositions,
  verifyDispositionLedger,
};
