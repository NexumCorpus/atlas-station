'use strict';

// Reuse tokenize from clusters.cjs if available; fall back to a simple implementation.
let _tokenize;
try {
  const _clusters = require('./clusters.cjs');
  if (typeof _clusters.tokenize === 'function') {
    _tokenize = _clusters.tokenize;
  }
} catch {}

if (!_tokenize) {
  _tokenize = function tokenize(text) {
    return (text || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
  };
}

function jaccard(setA, setB) {
  const sa = new Set(setA);
  const sb = new Set(setB);
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * scoreProposal(proposal, activeGoals) — Score a proposal against active goals.
 *
 * @param {Object} proposal  — proposal record with .description (or .text)
 * @param {Array}  activeGoals — array of goal records with .text
 * @returns {{ score, coherence, effortLevel, impactLevel, reason }}
 */
function scoreProposal(proposal, activeGoals) {
  const desc = (proposal.description || proposal.text || proposal.proposal || '').toLowerCase();
  const goalText = (activeGoals || []).map(g => g.text || '').join(' ').toLowerCase();

  // Coherence: Jaccard overlap between proposal tokens and active goal tokens
  const propTokens = _tokenize(desc);
  const goalTokens = _tokenize(goalText);
  const coherence = goalTokens.length > 0 ? jaccard(propTokens, goalTokens) : 0;

  // Effort level
  let effortLevel = 'medium';
  if (/rewrite|migrate|restructure/.test(desc)) effortLevel = 'high';
  else if (/\badd\b|fix|update/.test(desc)) effortLevel = 'low';

  // Impact level
  let impactLevel = 'medium';
  if (/core|daemon|fleet|startup/.test(desc)) impactLevel = 'high';
  else if (/minor|small|cosmetic/.test(desc)) impactLevel = 'low';

  // Score: coherence*40 + impact bonus - effort penalty, clamped 0-100
  const raw = Math.round(
    coherence * 40 +
    (impactLevel === 'high' ? 40 : impactLevel === 'medium' ? 20 : 0) -
    (effortLevel === 'high' ? 20 : effortLevel === 'medium' ? 10 : 0)
  );
  const score = Math.max(0, Math.min(100, raw));

  const reason = [
    `coherence ${Math.round(coherence * 100)}%`,
    `impact:${impactLevel}`,
    `effort:${effortLevel}`,
  ].join(', ');

  return { score, coherence, effortLevel, impactLevel, reason };
}

module.exports = { scoreProposal };
