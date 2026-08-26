'use strict';
// priority-queue.cjs — work-intake priority classification for Hermes proposals.
// Ranks: 1=operator directive, 2=verified defect, 3=scored proposal, 4=dream/idea.
// Standing rule encoded here (commits 15116ce, 72d44f3): 'truncated build brief' dreams
// are record-cap misdiagnoses (memstore.cjs:184 caps records at 500 chars;
// _wrapBuildBrief sends full text) — such items must be rejected at intake.

const MISDIAGNOSIS_RE = /(truncat|cut mid|## Build Brief).*(brief|dispatch)/i;

function isDreamLike(source) {
  return typeof source === 'string' && /dream|idea/i.test(source);
}

function classifyPriority(item) {
  if (!item || typeof item !== 'object') {
    return { rank: 4, reason: 'warning: no item object; defaulted to rank 4' };
  }
  const warnings = [];
  // Rank 1: operator directive
  if (item.source === 'operator') {
    return { rank: 1, reason: 'operator directive' };
  }
  // Rank 2: verified defect (reproduced against current master)
  if (item.verified === true) {
    const missing = [];
    if (item.priorArtChecked !== true) missing.push('priorArtChecked');
    if (item.defectStillExists !== true) missing.push('defectStillExists');
    if (!missing.length) {
      return { rank: 2, reason: 'verified defect (reproduced against current master)' };
    }
    warnings.push(`warning: verified=true but missing evidence fields: ${missing.join(', ')}`);
    return { rank: 4, reason: 'unverified defect claims lack evidence fields (' + missing.join(', ') + '); fell to rank 4', warning: warnings.join('; ') };
  }
  // Rank 3: scored proposal
  if (typeof item.score === 'number' && Number.isFinite(item.score)) {
    return { rank: 3, reason: 'scored proposal (score ' + item.score + ')' };
  }
  // Rank 4: dream/idea
  if (isDreamLike(item.source)) {
    return { rank: 4, reason: 'dream/idea' };
  }
  warnings.push('warning: item lacks required evidence fields (source/verified/score); defaulted to rank 4');
  return { rank: 4, reason: 'insufficient evidence fields; defaulted to rank 4', warning: warnings.join('; ') };
}

// Returns true (reject) for the known misdiagnosis class: dream-source items whose
// text claims truncated/cut-off build briefs or dispatches.
function dreamMisdiagnosisGuard(item) {
  try {
    if (!item || typeof item !== 'object') return false;
    const text = String(item.text || item.description || item.proposal || '');
    if (!text) return false;
    if (!MISDIAGNOSIS_RE.test(text)) return false;
    if (!isDreamLike(item.source)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function sortQueue(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => ({ item, rank: classifyPriority(item).rank }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const sa = typeof a.item.score === 'number' ? a.item.score : -Infinity;
      const sb = typeof b.item.score === 'number' ? b.item.score : -Infinity;
      if (sa !== sb) return sb - sa;
      const ta = Date.parse(a.item.ts) || 0;
      const tb = Date.parse(b.item.ts) || 0;
      if (ta !== tb) return ta - tb;
      return 0; // Array.prototype.sort is stable in modern Node
    })
    .map(e => e.item);
}

module.exports = { classifyPriority, dreamMisdiagnosisGuard, sortQueue };
