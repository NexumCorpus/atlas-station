const fs=require('fs');
const cands=['E:/atlas-station/.atlas/deferred.ndjson','E:/atlas-station/.atlas/memory/deferred.ndjson','E:/atlas-station/deferred.ndjson'];
let found=null;
for(const p of cands){ if(fs.existsSync(p)){ found=p; break; } }
if(!found){ console.log('deferred.ndjson NOT FOUND in candidates'); process.exit(0); }
console.log('FILE:',found);
const lines=fs.readFileSync(found,'utf8').trim().split('\n').filter(Boolean);
console.log('total lines:',lines.length);
const counts={};
for(const l of lines){
  try{
    const j=JSON.parse(l);
    const k=j.status||j.kind||'unknown';
    counts[k]=(counts[k]||0)+1;
  }catch(e){ counts['PARSE_ERROR']=(counts['PARSE_ERROR']||0)+1; }
}
console.log('by status/kind:',JSON.stringify(counts));
// sample keys
const j0=JSON.parse(lines[0]);
console.log('keys:',Object.keys(j0).join(','));
