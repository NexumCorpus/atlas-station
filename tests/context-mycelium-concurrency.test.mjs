import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const repo = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-context-mycelium-'));
const files = ['context-mycelium.cjs', 'shard-codec.cjs', 'append-lock.cjs'];

function sha(value) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')}`;
}

function runWorker(worker) {
  const modulePath = path.join(root, 'context-mycelium.cjs');
  const code = `
    const mycelium = require(${JSON.stringify(modulePath)});
    for (let i = 0; i < 5; i += 1) {
      const marker = ${JSON.stringify(worker)} + '-' + i;
      const source = '[Concurrent ' + marker + ']\\n' + marker + ':' + 'x'.repeat(3200);
      mycelium.build('concurrency ' + marker, { maxContextChars: 900 }, () => '--- ATLAS MEMORY ---\\n' + source + '\\n--- END MEMORY ---');
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`)));
  });
}

try {
  for (const file of files) fs.copyFileSync(path.join(repo, file), path.join(root, file));
  await Promise.all(Array.from({ length: 6 }, (_, index) => runWorker(`w${index}`)));

  const manifest = path.join(root, '.atlas', 'context-mycelium', 'crystals.ndjson');
  const rows = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(rows.length, 60, 'each build should durably append one tissue and one selection receipt');
  let prior = null;
  rows.forEach((row, index) => {
    const unsigned = { ...row };
    delete unsigned.recordHash;
    assert.equal(row.seq, index + 1, `sequence should remain linear at record ${index + 1}`);
    assert.equal(row.priorHash, prior, `prior hash should remain linear at record ${index + 1}`);
    assert.equal(row.recordHash, sha(JSON.stringify(unsigned)), `record ${index + 1} should retain a valid hash`);
    prior = row.recordHash;
  });
  assert.equal(fs.existsSync(`${manifest}.lock`), false, 'append lock should be released after concurrent writers finish');
  const staleLock = `${manifest}.lock`;
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner', ts: Date.now() - 60_000 }));
  const require = createRequire(import.meta.url);
  const lockApi = require(path.join(root, 'append-lock.cjs'));
  const recovered = lockApi.acquire(staleLock, 1000);
  lockApi.release(staleLock, recovered);
  assert.equal(fs.existsSync(staleLock), false, 'a dead writer should not leave a permanent manifest lock');

  const validManifest = path.join(root, 'valid-manifest.ndjson');
  const validRow = { kind: 'test', seq: 1, priorHash: null, issuedAt: new Date(0).toISOString() };
  validRow.recordHash = sha(JSON.stringify(validRow));
  fs.writeFileSync(validManifest, `${JSON.stringify(validRow)}\n`, 'utf8');
  const repair = spawnSync(process.execPath, [path.join(repo, 'scripts', 'repair-context-manifest.cjs'), validManifest], { encoding: 'utf8' });
  assert.equal(repair.status, 0, `valid-manifest diagnostic should succeed: ${repair.stderr}`);
  assert.match(repair.stdout, /"reason":"manifest already valid"/);
  assert.equal(fs.existsSync(`${validManifest}.lock`), false, 'valid-manifest diagnostic should release its lock');
  console.log(`context mycelium concurrency: ALL PASS (${rows.length} records)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
