'use strict';
const fs = require('fs');
const path = require('path');

const INSTR_FILE = (dir) => path.join(dir, 'instructions.ndjson');

function _saveInstructions(data, filePath) {
  fs.writeFileSync(filePath + '.tmp', data.map(i => JSON.stringify(i)).join('\n') + (data.length ? '\n' : ''), 'utf8');
  fs.renameSync(filePath + '.tmp', filePath);
}

function setInstruction(key, instruction, memDir) {
  if (!key || key.toString().trim() === '') {
    throw new Error('setInstruction: key is required and must be non-empty');
  }
  if (instruction === null || instruction === undefined || instruction.toString().trim() === '') {
    throw new Error('setInstruction: instruction is required and must be non-empty');
  }
  // Load existing, replace if key exists
  const all = listInstructions(memDir).filter(i => i.key !== key);
  all.push({ key, instruction, ts: new Date().toISOString() });
  _saveInstructions(all, INSTR_FILE(memDir));
}

function clearInstruction(key, memDir) {
  const remaining = listInstructions(memDir).filter(i => i.key !== key);
  _saveInstructions(remaining, INSTR_FILE(memDir));
}

function listInstructions(memDir) {
  const f = INSTR_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  const rawLines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  const valid = rawLines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(i => i && i.key && i.instruction); // require both fields; rejects legacy {text} entries
  if (valid.length < rawLines.length) {
    try { _saveInstructions(valid, f); } catch {}
  }
  return valid;
}

module.exports = { setInstruction, clearInstruction, listInstructions };
