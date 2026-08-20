'use strict';

const fs = require('fs');

function validRecord(record, seq, previous, hash) {
  if (!record || record.seq !== seq || record.prevRecordHash !== previous) return false;
  const body = { ...record };
  delete body.recordHash;
  return record.recordHash === hash(body);
}

function prefixHead(text, hash) {
  let previous = null;
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); } catch (error) { throw new Error(`work-eater recovery prefix invalid at line ${index + 1}: ${error.message}`); }
    if (!validRecord(record, index + 1, previous, hash)) throw new Error(`work-eater recovery prefix chain mismatch at seq ${index + 1}`);
    previous = record.recordHash;
  }
  return { records: lines.length, head: previous };
}

function quarantinePending(pendingPath) {
  const rejected = `${pendingPath}.rejected`;
  try { fs.unlinkSync(rejected); } catch {}
  fs.renameSync(pendingPath, rejected);
}

function recoverPending(ledgerPath, pendingPath, hash) {
  if (!fs.existsSync(pendingPath)) return null;
  const pendingText = fs.readFileSync(pendingPath, 'utf8');
  let pending;
  try { pending = JSON.parse(pendingText.trim()); } catch { quarantinePending(pendingPath); return 'invalid-pending-quarantined'; }
  if (!validRecord(pending, pending.seq, pending.prevRecordHash, hash) || !pendingText.endsWith('\n')) {
    quarantinePending(pendingPath);
    return 'invalid-pending-quarantined';
  }
  const raw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  if (raw.endsWith(pendingText)) { fs.unlinkSync(pendingPath); return 'already-appended'; }
  const cut = raw.endsWith('\n') ? raw.length : raw.lastIndexOf('\n') + 1;
  const prefix = raw.slice(0, cut);
  const state = prefixHead(prefix, hash);
  if (pending.seq !== state.records + 1 || pending.prevRecordHash !== state.head) throw new Error('work-eater pending record does not extend the valid ledger head');
  const fd = fs.openSync(ledgerPath, 'w');
  try { fs.writeSync(fd, prefix + pendingText, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.unlinkSync(pendingPath);
  return raw.length === prefix.length ? 'pending-appended' : 'torn-append-repaired';
}

function appendCrashSafe(ledgerPath, pendingPath, line) {
  const staged = fs.openSync(pendingPath, 'wx');
  try { fs.writeFileSync(staged, line, 'utf8'); fs.fsyncSync(staged); } finally { fs.closeSync(staged); }
  const ledger = fs.openSync(ledgerPath, 'a');
  try { fs.writeSync(ledger, line, null, 'utf8'); fs.fsyncSync(ledger); } finally { fs.closeSync(ledger); }
  fs.unlinkSync(pendingPath);
}

function linkRecovery(engine, contractHash, recovery) {
  return engine._withLock(() => {
    const records = engine.records();
    if (!records.some(row => row.kind === 'contract-born' && row.payload.contract.contractHash === contractHash)) throw new Error(`unknown abolition contract: ${contractHash}`);
    const prior = records.find(row => row.kind === 'recovery-linked' && row.payload.contractHash === contractHash);
    return prior || engine._append('recovery-linked', { contractHash, recovery });
  });
}

module.exports = { appendCrashSafe, recoverPending, linkRecovery };
