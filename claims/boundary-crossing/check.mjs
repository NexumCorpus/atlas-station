// check.mjs — boundary validation check
// Seed 0: addGoal(null) should throw
// Seed 1: addGoal('') should throw
// Seed 2: setInstruction('', 'instr') should throw
// Seed 3+: other modules/dimensions (handled generically)
'use strict';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const seed = parseInt(process.argv[2]);

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'boundary-check-'));
}

function assertThrows(fn, msgPart, label) {
  let threw = false, msg = '';
  try { fn(); } catch(e) { threw = true; msg = e.message || ''; }
  if (!threw) {
    process.stderr.write('FAIL ' + label + ': did not throw\n');
    process.exit(1);
  }
  if (msgPart && !msg.includes(msgPart)) {
    process.stderr.write('FAIL ' + label + ': threw but message missing "' + msgPart + '": ' + msg + '\n');
    process.exit(1);
  }
  process.stdout.write('PASS ' + label + '\n');
}

const ROOT = join(__dirname, '..', '..');
const dir = tempDir();

try {
  if (seed === 0) {
    const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
    assertThrows(() => addGoal(null, 'high', 'test', dir), 'required', 'addGoal(null) throws');
  } else if (seed === 1) {
    const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
    assertThrows(() => addGoal('', 'medium', 'test', dir), 'required', 'addGoal("") throws');
  } else if (seed === 2) {
    const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
    assertThrows(() => setInstruction('', 'some instruction', dir), 'required', 'setInstruction("",instr) throws');
  } else if (seed === 3) {
    const { saveRoutine } = require(join(ROOT, 'routines.cjs'));
    assertThrows(() => saveRoutine('', 'desc', [{tool: 'x'}], dir), 'required', 'saveRoutine("") throws');
  } else if (seed === 4) {
    const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
    assertThrows(() => setInstruction('valid-key', '', dir), 'required', 'setInstruction(key,"") throws');
  } else {
    process.stderr.write('unknown seed: ' + seed + '\n');
    process.exit(1);
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
