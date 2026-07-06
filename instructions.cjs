'use strict';
const fs = require('fs');
const path = require('path');

const INSTR_FILE = (dir) => path.join(dir, 'instructions.ndjson');

function setInstruction(key, instruction, memDir) {
  // Load existing, replace if key exists
  const all = listInstructions(memDir).filter(i => i.key !== key);
  all.push({ key, instruction, ts: new Date().toISOString() });
  fs.writeFileSync(INSTR_FILE(memDir), all.map(i => JSON.stringify(i)).join('\n') + '\n', 'utf8');
}

function clearInstruction(key, memDir) {
  const remaining = listInstructions(memDir).filter(i => i.key !== key);
  fs.writeFileSync(INSTR_FILE(memDir), remaining.map(i => JSON.stringify(i)).join('\n') + (remaining.length ? '\n' : ''), 'utf8');
}

function listInstructions(memDir) {
  const f = INSTR_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const rawLines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  const valid = rawLines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(i => i && i.key && i.instruction); // require both fields; rejects legacy {text} entries
  if (valid.length < rawLines.length) {
    try { fs.writeFileSync(f, valid.map(i => JSON.stringify(i)).join('\n') + (valid.length ? '\n' : ''), 'utf8'); } catch {}
  }
  return valid;
}

module.exports = { setInstruction, clearInstruction, listInstructions };
