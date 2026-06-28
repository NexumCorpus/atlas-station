'use strict';
const fs = require('fs');
const path = require('path');

// Tokenize text into lowercase words, filtering stopwords
const STOP = new Set(['a','an','the','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','to','of','in','for','on','with','at','by','from','as','into','through','during','before','after','above','below','up','down','out','off','over','under','again','then','once','and','or','but','if','so','yet','both','each','few','more','most','other','some','such','no','not','only','own','same','than','too','very','can','just','about','that','this','these','those','it','its','also','all','any','both','each','few','more','most','no','nor','not','only','or','other','so','than','too','very']);

function tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

// Score similarity between two token sets (Jaccard-like overlap)
function similarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let overlap = 0;
  setA.forEach(t => { if (setB.has(t)) overlap++; });
  return overlap / Math.max(setA.size, setB.size);
}

// Find past runs similar to a new task
// Returns array of { run, score } sorted by score descending
function findSimilarRuns(task, runsFile, opts = {}) {
  const { maxResults = 3, minScore = 0.12 } = opts;
  if (!fs.existsSync(runsFile)) return [];
  const taskTokens = tokenize(task);
  if (!taskTokens.length) return [];

  const lines = fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean);
  const runs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  return runs
    .filter(r => r.state === 'done' && r.task && r.summary)
    .map(r => ({ run: r, score: similarity(taskTokens, tokenize(r.task)) }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// Format the experience block to inject into a task prompt
function formatExperience(matches) {
  if (!matches.length) return null;
  const lines = ['\n\n[PAST EXPERIENCE — resonance from similar completed tasks]\n'];
  matches.forEach((m, i) => {
    lines.push(`${i + 1}. [${m.run.agentId || '?'}] score:${(m.score * 100).toFixed(0)}% cost:$${Number(m.run.cost || 0).toFixed(3)}`);
    lines.push(`   Task: ${(m.run.task || '').slice(0, 120)}`);
    lines.push(`   Outcome: ${(m.run.summary || '').slice(0, 200)}`);
    lines.push('');
  });
  lines.push('[Use this experience as context — not as a constraint. Adapt, not copy.]\n');
  return lines.join('\n');
}

module.exports = { findSimilarRuns, formatExperience, tokenize, similarity };
