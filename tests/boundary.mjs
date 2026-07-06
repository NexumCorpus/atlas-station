// tests/boundary.mjs — Boundary validation tests for ATLAS Station modules
// Tests null/empty/invalid inputs to verify guard clauses throw immediately.
// Run: node tests/boundary.mjs
// Exit 0 if all tests pass; non-zero if any fail.

import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function assertThrows(fn, msgPart, label) {
  let threw = false, msg = '';
  try { fn(); } catch (e) { threw = true; msg = e.message || ''; }
  if (!threw) {
    console.error('  FAIL:', label, '— did not throw');
    failed++;
    return;
  }
  if (msgPart && !msg.includes(msgPart)) {
    console.error('  FAIL:', label, '— threw but message missing "' + msgPart + '":', msg);
    failed++;
    return;
  }
  console.log('  PASS:', label);
  passed++;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'atlas-boundary-'));
}

console.log('\n=== ATLAS Boundary Validation Tests ===\n');

// ─── 1. goal-store: addGoal null/empty/undefined text ─────────────────────
console.log('1. goal-store: addGoal rejects null/empty/undefined text');
{
  const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => addGoal(null, 'high', 'test', dir), 'required', 'addGoal(null) throws');
    assertThrows(() => addGoal('', 'medium', 'test', dir), 'required', 'addGoal("") throws');
    assertThrows(() => addGoal(undefined, 'low', 'test', dir), 'required', 'addGoal(undefined) throws');
    assertThrows(() => addGoal('   ', 'medium', 'test', dir), 'required', 'addGoal("   ") throws (whitespace only)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 2. goal-store: addGoal accepts valid text ─────────────────────────────
console.log('\n2. goal-store: addGoal accepts valid text');
{
  const { addGoal, listGoals } = require(join(ROOT, 'goal-store.cjs'));
  const dir = tempDir();
  try {
    const g = addGoal('Build the station', 'high', 'engineering', dir);
    assert(g && g.id && g.text === 'Build the station', 'addGoal("Build the station") stores correctly');
    const goals = listGoals(dir);
    assert(goals.length === 1, 'one goal stored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 3. goal-store: resolveGoal rejects null id ───────────────────────────
console.log('\n3. goal-store: resolveGoal rejects null/falsy id');
{
  const { resolveGoal } = require(join(ROOT, 'goal-store.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => resolveGoal(null, 'done', dir), 'required', 'resolveGoal(null) throws');
    assertThrows(() => resolveGoal('', 'done', dir), 'required', 'resolveGoal("") throws');
    assertThrows(() => resolveGoal(undefined, 'done', dir), 'required', 'resolveGoal(undefined) throws');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 4. instructions: setInstruction rejects empty/null key ───────────────
console.log('\n4. instructions: setInstruction rejects empty/null key');
{
  const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => setInstruction('', 'some instruction', dir), 'required', 'setInstruction("",instr) throws');
    assertThrows(() => setInstruction(null, 'some instruction', dir), 'required', 'setInstruction(null,instr) throws');
    assertThrows(() => setInstruction('   ', 'some instruction', dir), 'required', 'setInstruction("   ",instr) throws (whitespace key)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 5. instructions: setInstruction rejects empty/null instruction ────────
console.log('\n5. instructions: setInstruction rejects empty/null instruction');
{
  const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => setInstruction('valid-key', '', dir), 'required', 'setInstruction(key,"") throws');
    assertThrows(() => setInstruction('valid-key', null, dir), 'required', 'setInstruction(key,null) throws');
    assertThrows(() => setInstruction('valid-key', undefined, dir), 'required', 'setInstruction(key,undefined) throws');
    assertThrows(() => setInstruction('valid-key', '   ', dir), 'required', 'setInstruction(key,"   ") throws (whitespace)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 6. instructions: setInstruction accepts valid key+instruction ──────────
console.log('\n6. instructions: setInstruction accepts valid inputs');
{
  const { setInstruction, listInstructions } = require(join(ROOT, 'instructions.cjs'));
  const dir = tempDir();
  try {
    setInstruction('rule-1', 'Always verify before committing', dir);
    const all = listInstructions(dir);
    assert(all.length === 1 && all[0].key === 'rule-1', 'valid setInstruction stores and retrieves correctly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 7. routines: saveRoutine rejects empty/null name ─────────────────────
console.log('\n7. routines: saveRoutine rejects empty/null name');
{
  const { saveRoutine } = require(join(ROOT, 'routines.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => saveRoutine('', 'desc', [{ tool: 'x' }], dir), 'required', 'saveRoutine("",desc,steps) throws');
    assertThrows(() => saveRoutine(null, 'desc', [{ tool: 'x' }], dir), 'required', 'saveRoutine(null,...) throws');
    assertThrows(() => saveRoutine('   ', 'desc', [{ tool: 'x' }], dir), 'required', 'saveRoutine("   ",...) throws (whitespace)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 8. routines: saveRoutine rejects null/empty steps ────────────────────
console.log('\n8. routines: saveRoutine rejects null/empty steps');
{
  const { saveRoutine } = require(join(ROOT, 'routines.cjs'));
  const dir = tempDir();
  try {
    assertThrows(() => saveRoutine('my-routine', 'desc', null, dir), 'non-empty array', 'saveRoutine(name,desc,null) throws');
    assertThrows(() => saveRoutine('my-routine', 'desc', [], dir), 'non-empty array', 'saveRoutine(name,desc,[]) throws');
    assertThrows(() => saveRoutine('my-routine', 'desc', 'not-array', dir), 'non-empty array', 'saveRoutine(name,desc,"string") throws');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 9. routines: saveRoutine accepts valid inputs ─────────────────────────
console.log('\n9. routines: saveRoutine accepts valid inputs');
{
  const { saveRoutine, listRoutines } = require(join(ROOT, 'routines.cjs'));
  const dir = tempDir();
  try {
    saveRoutine('deploy', 'Deploy the station', [{ tool: 'bash', args: { cmd: 'npm run build' } }], dir);
    const all = listRoutines(dir);
    assert(all.length === 1 && all[0].name === 'deploy', 'valid saveRoutine stores and retrieves correctly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log('Passed:', passed);
console.log('Failed:', failed);
if (failed > 0) {
  console.error('\nBOUNDARY TESTS FAILED:', failed, 'failure(s)');
  process.exit(1);
} else {
  console.log('\nAll boundary tests passed.');
  process.exit(0);
}
