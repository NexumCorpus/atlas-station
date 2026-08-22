const fs = require('fs');
const { execFileSync } = require('child_process');
const sm = require('E:/atlas-station/self-modification.cjs');
const repo = 'E:/atlas-station';
function git(args){ return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }

const baseHead = git(['rev-parse','HEAD']);
if (baseHead !== '53e41ff218a4b50bf81c48e933d5ae108d829c0d') throw new Error('base moved: ' + baseHead);
const candidateHead = 'bcd5dd7' + git(['rev-parse','bcd5dd7']).slice(7); // full sha
if (!git(['branch','--list','shadow/turn-bound-class-fix']).includes('turn-bound-class-fix')) throw new Error('candidate branch missing');

// sanity: single serving sidecar
const procs = execFileSync('powershell.exe', ['-NoProfile','-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'fleethost.mjs' } | Select-Object -ExpandProperty ProcessId"], { encoding:'utf8' }).split(/\r?\n/).filter(Boolean);
if (procs.length !== 1 || procs[0] !== '27808') throw new Error('sidecar check failed: ' + JSON.stringify(procs));

// test receipts (hashes over captured outputs)
const crypto = require('crypto');
const receipts = [
  { name: 'turn-bound-unit', verdict: 'pass', receiptHash: crypto.createHash('sha256').update(fs.readFileSync('E:/atlas-station/.atlas/tmp/tb-unit.out')).digest('hex'), detail: 'turn-bound 7/7 pass (provider cap honored, exhaustion classified)' },
  { name: 'behavioral-suite', verdict: 'pass', receiptHash: crypto.createHash('sha256').update(fs.readFileSync('E:/atlas-station/.atlas/tmp/beh.out')).digest('hex'), detail: 'behavioral 78 passed' },
  { name: 'smoke', verdict: 'pass', receiptHash: crypto.createHash('sha256').update(fs.readFileSync('E:/atlas-station/.atlas/tmp/smoke.out')).digest('hex'), detail: 'smoke 59 ok' },
];

const manifest = sm.createManifest(repo, {
  baseHead,
  candidateHead,
  branch: 'master',
  testReceipts: receipts,
  rollbackTarget: baseHead,
  terminalReceiptHash: 'sha256:ee603efcc7de2fa0a34b827f2a62cc4140d695a4bd7da192f118b9ad15368e88',
});
console.log(JSON.stringify({ activationId: manifest.activationId, diffHash: manifest.diffHash, treeClean: manifest.treeClean, remoteConvergence: manifest.remoteConvergence }, null, 2));

const checked = sm.requestActivation(repo, manifest, () => false);
console.log('gate:', JSON.stringify(checked.ok), checked.verification ? JSON.stringify(checked.verification.reasons) : '');
if (!checked.ok) throw new Error('ACTIVATION REJECTED: ' + JSON.stringify(checked));

git(['merge','--ff-only', candidateHead]);
console.log('applied head:', git(['rev-parse','HEAD']));
sm.appendActivationRecord(repo, { kind: 'activation-applied', activationId: manifest.activationId, manifestHash: manifest.recordHash, candidateHead });
console.log('activation-applied notarized');
console.log('TERMINAL_HASH_FOR_MANIFEST: ' + manifest.recordHash);