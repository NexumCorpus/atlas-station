'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const journal = require('./ingress-journal.cjs');

function sha(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n', null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (error) { if (!['EPERM', 'EINVAL', 'EISDIR'].includes(error.code)) throw error; }
}
function diffHash(repo, baseHead, candidateHead) { return sha(execFileSync('git', ['-C', repo, 'diff', '--binary', `${baseHead}..${candidateHead}`])); }
function treeDirty(repo) { return git(repo, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).filter(line => !line.slice(3).replace(/^\"|\"$/g, '').startsWith('.atlas' + path.sep) && !line.slice(3).replace(/^\"|\"$/g, '').startsWith('.atlas/')).length > 0; }
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function manifestPath(repo, id) { return path.join(repo, '.atlas', 'activation-manifests', `${safeId(id)}.json`); }
function createManifest(repo, input = {}) {
  const baseHead = input.baseHead || git(repo, ['rev-parse', 'HEAD']); const candidateHead = input.candidateHead || git(repo, ['rev-parse', input.branch || 'HEAD']);
  const branch = input.branch || git(repo, ['branch', '--show-current']); const id = input.activationId || `activation:${candidateHead}`;
  const manifest = { schema: 1, activationId: id, baseHead, candidateHead, branch, diffHash: diffHash(repo, baseHead, candidateHead),
    testReceipts: input.testReceipts || [], treeClean: !treeDirty(repo), remoteConvergence: input.remoteConvergence || null,
    rollbackTarget: input.rollbackTarget || baseHead, createdAt: new Date().toISOString() };
  manifest.recordHash = sha(JSON.stringify(manifest)); atomicJson(manifestPath(repo, id), manifest); return { ...manifest, manifestPath: manifestPath(repo, id) };
}
function verifyManifest(repo, manifest, isActive = () => false) {
  const reasons = []; try { if (git(repo, ['rev-parse', 'HEAD']) !== manifest.baseHead) reasons.push('base-head-mismatch'); } catch { reasons.push('base-head-unreadable'); }
  try { if (git(repo, ['merge-base', '--is-ancestor', manifest.baseHead, manifest.candidateHead]) !== '') {} } catch { reasons.push('candidate-not-fast-forward'); }
  try { if (diffHash(repo, manifest.baseHead, manifest.candidateHead) !== manifest.diffHash) reasons.push('diff-hash-mismatch'); } catch { reasons.push('candidate-diff-unreadable'); }
  try { if (treeDirty(repo)) reasons.push('tree-dirty'); } catch { reasons.push('tree-unreadable'); }
  if (manifest.rollbackTarget !== manifest.baseHead) reasons.push('rollback-target-mismatch');
  if (isActive()) reasons.push('active-turn');
  if (!manifest.testReceipts.length || manifest.testReceipts.some(r => r.verdict !== 'pass')) reasons.push('tests-not-proven');
  return { ok: reasons.length === 0, reasons, manifestHash: manifest.recordHash };
}
function appendActivationRecord(repo, record) { return journal.append(path.join(repo, '.atlas'), { kind: record.kind, activationId: record.activationId, manifestHash: record.manifestHash, candidateHead: record.candidateHead, ...record }); }
function requestActivation(repo, manifest, isActive = () => false) {
  const verification = verifyManifest(repo, manifest, isActive);
  const request = appendActivationRecord(repo, { kind: 'activation-request', activationId: manifest.activationId, manifestHash: manifest.recordHash, candidateHead: manifest.candidateHead });
  if (!verification.ok) { const rejected = appendActivationRecord(repo, { kind: 'activation-rejected', activationId: manifest.activationId, manifestHash: manifest.recordHash, reasons: verification.reasons }); return { ok: false, verification, request, rejected }; }
  const verified = appendActivationRecord(repo, { kind: 'activation-verified', activationId: manifest.activationId, manifestHash: manifest.recordHash, candidateHead: manifest.candidateHead });
  return { ok: true, verification, request, verified };
}
module.exports = { sha, git, manifestPath, createManifest, verifyManifest, appendActivationRecord, requestActivation };
