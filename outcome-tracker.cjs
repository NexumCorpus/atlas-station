'use strict';
const fs = require('fs');
const path = require('path');

const OUTCOMES_FILE = (dir) => path.join(dir, 'outcomes.ndjson');

// rating: 'good' | 'partial' | 'bad' | 1-5
function rateOutcome(agentId, rating, notes, memDir) {
  const normalized = typeof rating === 'number'
    ? (rating >= 4 ? 'good' : rating >= 2 ? 'partial' : 'bad')
    : String(rating).toLowerCase();
  const entry = { agentId, rating: normalized, notes: notes || '', ts: new Date().toISOString() };
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

module.exports = { rateOutcome, getOutcomes, outcomeStats };
