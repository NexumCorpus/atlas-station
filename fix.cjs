const fs=require('fs');
let lines=fs.readFileSync('patch-retry.cjs','utf8').split('\n');
lines[38]="].join(String.fromCharCode(10)) + NL + IND + a4);";
// also fix the opening: ensure it's 's = s.replace(a4, ([' style
for(let i=0;i<lines.length;i++){ if(lines[i].includes('s.replace(a4,')){ lines[i]=lines[i].replace('lit([','[').replace('(','('); } }
fs.writeFileSync('patch-retry.cjs',lines.join('\n'));
console.log(lines.filter(l=>l.includes('a4')).join('\n'));
