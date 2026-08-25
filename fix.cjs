const fs=require('fs');
let p=fs.readFileSync('patch-retry.cjs','utf8');
p=p.replace("s = s.replace(a4, ([", "s = s.replace(a4, lit([");
p=p.replace("}).join(NL) + NL + '      ' + a4);", "].join('\n')) + NL + '      ' + a4);");
fs.writeFileSync('patch-retry.cjs',p);
console.log('ok2');
