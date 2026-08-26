'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const appendLock = require('../append-lock.cjs');

const manifest = path.resolve(process.argv[2] || path.join(__dirname, '..', '.atlas', 'context-mycelium', 'crystals.ndjson'));
const lockPath = `${manifest}.lock`;

function sha(value) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex')}`;
}

function unsignedHash(row) {
  const unsigned = { ...row };
  delete unsigned.recordHash;
  return sha(JSON.stringify(unsigned));
}

if (!fs.existsSync(manifest)) throw new Error(`manifest does not exist: ${manifest}`);
let lock;
try {
  lock = appendLock.acquire(lockPath, 10_000);
  const original = fs.readFileSync(manifest);
  const rows = original.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`manifest line ${index + 1} is invalid JSON: ${error.message}`); }
  });
  let prior = null;
  let divergence = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.seq !== index + 1 || row.priorHash !== prior || row.recordHash !== unsignedHash(row)) { divergence = index; break; }
    prior = row.recordHash;
  }
  if (divergence < 0) {
    console.log(JSON.stringify({ repaired: false, reason: 'manifest already valid', records: rows.length, head: prior }));
  } else {
    const divergent = rows.slice(divergence);
    divergent.forEach((row, offset) => {
      if (row.recordHash !== unsignedHash(row)) throw new Error(`refusing recovery: divergent line ${divergence + offset + 1} is not self-authenticating`);
    });

    const recoveredAt = new Date().toISOString();
    const canonical = rows.slice(0, divergence);
    prior = canonical.at(-1)?.recordHash || null;
    for (const row of divergent) {
      const originalRecordHash = row.recordHash;
      const originalSeq = row.seq;
      const originalPriorHash = row.priorHash;
      const recovered = {
        ...row,
        seq: canonical.length + 1,
        priorHash: prior,
        recovery: { kind: 'fork-rechain', originalSeq, originalPriorHash, originalRecordHash, recoveredAt },
      };
      delete recovered.recordHash;
      recovered.recordHash = unsignedHash(recovered);
      canonical.push(recovered);
      prior = recovered.recordHash;
    }

    const originalHash = sha(original);
    const stamp = recoveredAt.replace(/[:.]/g, '-');
    const backup = `${manifest}.fork-${stamp}.bak`;
    const receipt = {
      kind: 'manifest-recovery',
      schema: 1,
      originalFileHash: originalHash,
      originalRecordCount: rows.length,
      divergenceLine: divergence + 1,
      recoveredRecordHashes: divergent.map(row => row.recordHash),
      backupPath: path.basename(backup),
      seq: canonical.length + 1,
      priorHash: prior,
      issuedAt: recoveredAt,
    };
    receipt.recordHash = unsignedHash(receipt);
    canonical.push(receipt);

    const temporary = `${manifest}.repair-${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${canonical.map(row => JSON.stringify(row)).join('\n')}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(manifest, backup);
    try { fs.renameSync(temporary, manifest); }
    catch (error) { fs.renameSync(backup, manifest); throw error; }

    console.log(JSON.stringify({ repaired: true, originalHash, backup, divergenceLine: divergence + 1, recovered: divergent.length, records: canonical.length, head: receipt.recordHash }));
  }
} finally {
  appendLock.release(lockPath, lock);
}
