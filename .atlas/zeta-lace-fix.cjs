const fs=require('fs');
let s=fs.readFileSync('providers/openrouter.mjs','utf8');
const bad1='wake ? "[Estate Wake Digest - live]\n" + wake.trim() : ""';
const good1='wake ? "[Estate Wake Digest - live]\\n" + wake.trim() : ""';
if(!s.includes(bad1)) throw new Error('anchor1 missing');
s=s.split(bad1).join(good1);
const bad2='].filter(Boolean).join("\n");';
const good2='].filter(Boolean).join("\\n");';
// only inside zetaLace - it is the only occurrence of that exact pattern
if(!s.includes(bad2)) throw new Error('anchor2 missing');
s=s.replace(bad2,good2);
fs.writeFileSync('providers/openrouter.mjs',s);
console.log('fixed');
