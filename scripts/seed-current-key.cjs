'use strict';
// Seed the sentinel registry with the CURRENT OpenRouter key's expiry.
// The raw value is read from .env inside this process only, fingerprinted,
// and never persisted or printed.
const fs = require('fs');
const path = require('path');
const keys = require('../provider-keys.cjs');
const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const line = envText.split(/\r?\n/).find((l) => l.startsWith('OPENROUTER_API_KEY='));
if (!line) { console.error('OPENROUTER_API_KEY not found in .env'); process.exit(1); }
const value = line.slice('OPENROUTER_API_KEY='.length).trim();
if (!value) { console.error('empty key value'); process.exit(1); }
const rec = keys.registerKey({
  label: 'openrouter-cortex',
  provider: 'openrouter',
  // Daniel: fresh key valid ~1 week, supplied 2026-08-21. Documented estimate.
  expiresAt: '2026-08-28T12:00:00Z',
  warnDays: 3,
  source: 'daniel-supplied-2026-08-21',
  value,
}, path.join(__dirname, '..', 'memory'));
console.log('registered:', rec.label, '| fingerprint:', rec.fingerprint, '| expires:', rec.expiresAt);
// Prove no raw value leaked to disk.
const persisted = fs.readFileSync(path.join(__dirname, '..', 'memory', 'provider-keys.json'), 'utf8');
if (persisted.includes(value)) { console.error('LEAK: raw value persisted'); process.exit(1); }
console.log('no-raw-value-on-disk: VERIFIED');
