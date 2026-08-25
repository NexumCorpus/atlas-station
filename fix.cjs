const fs=require('fs');
let lines=fs.readFileSync('patch-retry.cjs','utf8').split('\n');
lines.splice(38,1); // remove stray leftover line
fs.writeFileSync('patch-retry.cjs',lines.join('\n'));
