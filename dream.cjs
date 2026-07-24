'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DREAM_FILE = (dir) => path.join(dir, 'dreams.ndjson');
const DREAM_RECEIPT_FILE = (dir) => path.join(dir, 'dream-receipts.ndjson');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function writeDream(report, memDir) {
  const entry = {
    ts: new Date().toISOString(),
    patterns: report.patterns || [],
    insights: report.insights || [],
    proposals: report.proposals || [],
    mood: report.mood || 'neutral',
  };
  fs.appendFileSync(DREAM_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadDreams(memDir, maxN = 5) {
  const f = DREAM_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .slice(-maxN);
}

function writeDreamReceipt(receipt, memDir) {
  const input = receipt.input == null ? null : String(receipt.input);
  const output = receipt.output == null ? null : String(receipt.output);
  const entry = {
    ts: new Date().toISOString(),
    dreamId: receipt.dreamId || null,
    pulseCount: receipt.pulseCount ?? null,
    attempt: receipt.attempt ?? 1,
    event: receipt.event || 'terminal',
    state: receipt.state || null,
    task: receipt.task || null,
    input,
    inputSha256: receipt.inputSha256 || (input == null ? null : sha256(input)),
    inputBytes: receipt.inputBytes ?? (input == null ? 0 : Buffer.byteLength(input, 'utf8')),
    output,
    outputSha256: receipt.outputSha256 || (output == null ? null : sha256(output)),
    outputBytes: receipt.outputBytes ?? (output == null ? 0 : Buffer.byteLength(output, 'utf8')),
    error: receipt.error || null,
    exit: receipt.exit || null,
    source: receipt.source || 'dream-protocol',
  };
  fs.appendFileSync(DREAM_RECEIPT_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadDreamReceipts(memDir, maxN = 10) {
  const f = DREAM_RECEIPT_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .slice(-maxN);
}

module.exports = { writeDream, loadDreams, writeDreamReceipt, loadDreamReceipts, sha256 };
