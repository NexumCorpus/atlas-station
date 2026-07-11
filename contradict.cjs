// contradict.cjs — contradiction detector for facts.ndjson
'use strict';
const fs = require('fs'), path = require('path');
const FACTS_FILE = d => path.join(d, 'facts.ndjson');

const NEGATION = ['not','never','no','cannot','cant',"can't",'neither','nor','without','false','wrong','incorrect','fail','failed'];
const STOP = new Set(['the','a','an','is','are','was','were','it','in','on','at','to','of','and','or','but','for','with','this','that']);

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/).filter(w => w.length>2 && !STOP.has(w));
}

function hasNegation(text) {
  const lower = text.toLowerCase();
  return NEGATION.some(n => lower.includes(n));
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter(x => sb.has(x)).length;
  return inter / (sa.size + sb.size - inter);
}

function scanContradictions(memDir, minSimilarity=0.3) {
  const f = FACTS_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const facts = fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter(f => f.fact || f.text)
    .map(f => ({ key: f.key||f.ts, text: f.fact||f.text, tokens: tokenize(f.fact||f.text), negated: hasNegation(f.fact||f.text) }))
    .slice(-200); // scan last 200 facts

  const pairs = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i+1; j < facts.length; j++) {
      const a = facts[i], b = facts[j];
      if (a.negated === b.negated) continue; // only flag negation-flipped pairs
      const sim = jaccard(a.tokens, b.tokens);
      if (sim >= minSimilarity) pairs.push({a: a.key, b: b.key, similarity: sim, textA: a.text.slice(0,100), textB: b.text.slice(0,100)});
    }
  }
  return pairs.sort((a,b) => b.similarity - a.similarity).slice(0,10);
}

module.exports = { scanContradictions, tokenize, jaccard };
