const fs = require('fs');
let src = fs.readFileSync('fleethost.mjs', 'utf8');
const L = src.split('\n');
function cut(a, b) { L.splice(a - 1, b - a + 1); }
cut(554, 570);
cut(156, 269);
cut(128, 153);
src = L.join('\n');
const q = '"';
const imp = 'import { runBoundedChild } from ' + q + './providers/bounded-child.mjs' + q + ';\n'
  + 'import { REPO, WT_BASE, gitC, makeWorktree, branchStat, BUILD_NOTE } from ' + q + './providers/worktree.mjs' + q + ';\n'
  + 'import { SAFE, READ_DENY, pathInsideRepo, readGate } from ' + q + './providers/read-gate.mjs' + q + ';\n';
src = src.replace('import { execFileSync, spawn as spawnChild } from ' + q + 'child_process' + q + ';',
  'import { execFileSync } from ' + q + 'child_process' + q + ';\n' + imp);
fs.writeFileSync('fleethost.mjs', src);
console.log('done');
