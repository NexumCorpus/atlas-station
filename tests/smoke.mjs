// tests/smoke.mjs — require() every root-level .cjs module and report failures
// Run: node tests/smoke.mjs

import { createRequire } from 'module';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const require = createRequire(import.meta.url);

// Electron-process modules require the Electron runtime and cannot be
// require()'d in plain Node.js — skip them explicitly.
const ELECTRON_MODULES = new Set(['main.cjs', 'preload.cjs']);

const mods = readdirSync(ROOT).filter(f => f.endsWith('.cjs') && !ELECTRON_MODULES.has(f));
let ok = 0, bad = 0;
for (const m of mods) {
  try { require(join(ROOT, m)); console.log('OK  ', m); ok++; }
  catch(e) { console.error('FAIL', m, e.message.slice(0, 80)); bad++; }
}
console.log(`\n${ok} ok, ${bad} failed`);
if (bad > 0) process.exit(1);
