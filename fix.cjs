const fs=require('fs');
let s=fs.readFileSync('fleethost.mjs','utf8');
s=s.split('\n').filter(l=>!(l.startsWith('const REPO = process.env.ATLAS_REPO')||l.startsWith('const WT_BASE = process.env.ATLAS_WT'))).join('\n');
fs.writeFileSync('fleethost.mjs',s);
