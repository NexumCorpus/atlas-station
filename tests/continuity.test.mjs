import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { inspectFile, formatStatus } = require('../continuity.cjs');
const root = mkdtempSync(path.join(tmpdir(), 'atlas-continuity-'));
const file = path.join(root, 'crystals.ndjson');
const ledger = path.join(root, 'shards.jsonl');
const old = Buffer.from('old crystal bytes');
const oldPin = crypto.createHash('sha256').update(old).digest('hex').slice(0, 16);
writeFileSync(file, old);
writeFileSync(ledger, [0, 1, 2, 3].map((i) => JSON.stringify({
  path: file, crystal_pin: oldPin, k: 4, n: 6, i, frag_b64: 'AA==',
})).join('\n') + '\n');

const fresh = inspectFile(file, { ledgerPath: ledger });
assert.equal(fresh.status, 'fresh');
assert.match(formatStatus(fresh), /FRESH/);

writeFileSync(file, 'newer crystal bytes');
const stale = inspectFile(file, { ledgerPath: ledger });
assert.equal(stale.status, 'stale');
assert.equal(stale.snapshots[0].recoverable, true);
assert.match(formatStatus(stale), /STALE/);

const other = path.join(root, 'facts.ndjson');
writeFileSync(other, 'facts');
assert.equal(inspectFile(other, { ledgerPath: ledger }).status, 'unsharded');
assert.equal(inspectFile(path.join(root, 'missing'), { ledgerPath: ledger }).status, 'missing');

console.log('continuity: ALL PASS');
