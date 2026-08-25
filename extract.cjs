const fs = require('fs');
let src = fs.readFileSync('fleethost.mjs', 'utf8');
const L = src.split('\n');
function seg(a, b) { return L.slice(a - 1, b).join('\n'); }
const bc = seg(156, 269);
const rg = seg(128, 153);
const wt = seg(554, 570); // gitC..branchStat + BUILD_NOTE
fs.mkdirSync('providers', { recursive: true });
fs.writeFileSync('providers/bounded-child.mjs',
  'import { spawn as spawnChild } from "child_process";\nimport { REPO } from "./worktree.mjs";\n\n' + bc + '\n\nexport { runBoundedChild };\n');
fs.writeFileSync('providers/read-gate.mjs',
  'import path from "path";\nimport { REPO } from "./worktree.mjs";\n\n' + rg + '\n\nexport { SAFE, READ_DENY, pathInsideRepo, readGate };\n');
fs.writeFileSync('providers/worktree.mjs',
  'import { execFileSync } from "child_process";\nimport path from "path";\nimport { mkdirSync } from "fs";\n\n' +
  'const REPO = process.env.ATLAS_REPO || "E:' + String.fromCharCode(92, 92) + 'atlas-station";\n' +
  'const WT_BASE = process.env.ATLAS_WT || "E:' + String.fromCharCode(92, 92) + 'atlas-wt";\n\n' +
  wt + '\n\nexport { REPO, WT_BASE, gitC, makeWorktree, branchStat, BUILD_NOTE };\n');
console.log('ok');
