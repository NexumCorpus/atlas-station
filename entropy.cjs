// entropy.cjs — reply entropy tracking
'use strict';
const fs = require('fs'), path = require('path');
const ENTROPY_FILE = d => path.join(d, 'entropy.ndjson');

function measureEntropy(text) {
  const tokens = text.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return {ttr: 0, unique: 0, total: 0};
  const unique = new Set(tokens).size;
  return {ttr: unique / tokens.length, unique, total: tokens.length};
}

function recordEntropy(sessionId, replyText, memDir) {
  const e = measureEntropy(replyText);
  const entry = {sessionId, ts: new Date().toISOString(), ...e};
  fs.appendFileSync(ENTROPY_FILE(memDir), JSON.stringify(entry)+'\n', 'utf8');
  return entry;
}

function entropyTrend(memDir, n=20) {
  const f = ENTROPY_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .slice(-n);
}

function entropyStats(memDir) {
  const entries = entropyTrend(memDir, 50);
  if (!entries.length) return {count:0, avgTtr:null, trend:'no data'};
  const avg = entries.reduce((s,e) => s + e.ttr, 0) / entries.length;
  const first = entries.slice(0, Math.ceil(entries.length/2));
  const second = entries.slice(Math.ceil(entries.length/2));
  const avgFirst = first.reduce((s,e) => s + e.ttr, 0) / (first.length||1);
  const avgSecond = second.reduce((s,e) => s + e.ttr, 0) / (second.length||1);
  const trend = avgSecond > avgFirst + 0.02 ? 'increasing' : avgSecond < avgFirst - 0.02 ? 'decreasing' : 'stable';
  return {count: entries.length, avgTtr: avg, trend};
}

module.exports = { measureEntropy, recordEntropy, entropyTrend, entropyStats };
