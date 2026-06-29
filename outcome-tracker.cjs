'use strict';
const fs = require('fs');
const path = require('path');

const OUTCOMES_FILE = (dir) => path.join(dir, 'outcomes.ndjson');

function parseFailureMode(stderr) {
  const text = (stderr || '').toLowerCase();
  if (text.includes('merge conflict') || text.includes('conflict in') || text.includes('automatic merge failed')) return 'merge_conflict';
  if (text.includes('syntaxerror') || text.includes('error:') || text.includes('failed to')) return 'logic_error';
  if (text.includes('permission denied') || text.includes('enoent') || text.includes('eacces')) return 'environment';
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
  if (Array.isArray(causalChain) && causalChain.length) entry.causalChain = causalChain;
  fs.appendFileSync(OUTCOMES_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function getOutcomes(memDir, limit) {
  const f = OUTCOMES_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-(limit || 50)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
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

module.exports = { rateOutcome, getOutcomes, outcomeStats, parseFailureMode, failureProfile };
