// Adversarial boundary re-certification check.
// Seeds 0-2: null/empty class (claimed) — null-guard handles these.
// Seeds 3-4: ZWSP class (adversarial holdout) — '​'.trim() !== '', guard MISSES these.
// EXIT 0 = module correctly rejects input; EXIT 1 = guard missed it (bug survives).
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..', '..');

const ZWSP = '​'; // U+200B ZERO WIDTH SPACE — evades .trim() === ''

const seed = parseInt(process.argv[2]);
const dir = mkdtempSync(join(tmpdir(), 'adv-check-'));

function assertThrows(fn, label) {
  try {
    fn();
    process.stderr.write('FAIL seed=' + seed + ': ' + label + ' — guard did NOT throw (ZWSP stored as valid data)\n');
    process.exit(1);
  } catch (e) {
    process.stdout.write('PASS seed=' + seed + ': ' + label + ' — threw: "' + String(e.message).slice(0, 80) + '"\n');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

switch (seed) {
  // --- claimed seeds: null/empty class (null-guard correctly catches) -------
  case 0: {
    const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
    assertThrows(() => addGoal(null, 'high', 'test', dir), 'addGoal(null)');
    break;
  }
  case 1: {
    const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
    assertThrows(() => addGoal('', 'high', 'test', dir), 'addGoal("")');
    break;
  }
  case 2: {
    const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
    assertThrows(() => setInstruction('', 'some-instruction', dir), 'setInstruction(empty-key, value)');
    break;
  }
  // --- adversarial holdout seeds: ZWSP class — null-guard CANNOT intercept --
  case 3: {
    // ZWSP as instruction VALUE. '​'.trim() === '​', NOT '', guard fires? No.
    const { setInstruction } = require(join(ROOT, 'instructions.cjs'));
    assertThrows(() => setInstruction('valid-key', ZWSP, dir), 'setInstruction(key, ZWSP-value)');
    break;
  }
  case 4: {
    // ZWSP as goal TEXT. Same failure class.
    const { addGoal } = require(join(ROOT, 'goal-store.cjs'));
    assertThrows(() => addGoal(ZWSP, 'high', 'test', dir), 'addGoal(ZWSP-text)');
    break;
  }
  default:
    process.stderr.write('unknown seed: ' + seed + '\n');
    process.exit(1);
}
