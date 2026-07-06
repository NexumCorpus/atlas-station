// predict.cjs — prediction ledger for ATLAS Station
'use strict';
const fs = require('fs');
const path = require('path');
const PRED_FILE = (d) => path.join(d, 'predictions.ndjson');

function addPrediction(claim, confidence, memDir) {
  // confidence: 0.0–1.0 float
  const id = 'pred-' + Date.now();
  const entry = { id, claim, confidence: Math.min(1, Math.max(0, confidence)), ts: new Date().toISOString(), resolved: false, outcome: null, evidence: null, resolvedTs: null };
  fs.appendFileSync(PRED_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return id;
}

function resolvePrediction(id, outcome, evidence, memDir) {
  // outcome: 'correct' | 'incorrect'
  if (!['correct','incorrect'].includes(outcome)) throw new Error('outcome must be correct or incorrect');
  const f = PRED_FILE(memDir);
  if (!fs.existsSync(f)) throw new Error('no predictions file');
  const lines = fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean);
  let found = false;
  const updated = lines.map(l => {
    const p = JSON.parse(l);
    if (p.id === id) { found = true; return JSON.stringify({...p, resolved:true, outcome, evidence: evidence||null, resolvedTs: new Date().toISOString()}); }
    return l;
  });
  if (!found) throw new Error('prediction ' + id + ' not found');
  fs.writeFileSync(f + '.tmp', updated.join('\n') + '\n', 'utf8');
  fs.renameSync(f + '.tmp', f);
}

function getPredictions(memDir, opts = {}) {
  const f = PRED_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter(p => opts.unresolved ? !p.resolved : true)
    .slice(-(opts.limit || 20));
}

function predictionAccuracy(memDir) {
  const all = getPredictions(memDir);
  const resolved = all.filter(p => p.resolved);
  if (!resolved.length) return { total: all.length, resolved: 0, accuracy: null, avgConfidenceCorrect: null, avgConfidenceIncorrect: null };
  const correct = resolved.filter(p => p.outcome === 'correct');
  const incorrect = resolved.filter(p => p.outcome === 'incorrect');
  const avg = arr => arr.length ? arr.reduce((s,p) => s + p.confidence, 0) / arr.length : null;
  return { total: all.length, resolved: resolved.length, accuracy: correct.length / resolved.length, avgConfidenceCorrect: avg(correct), avgConfidenceIncorrect: avg(incorrect) };
}

module.exports = { addPrediction, resolvePrediction, getPredictions, predictionAccuracy };
