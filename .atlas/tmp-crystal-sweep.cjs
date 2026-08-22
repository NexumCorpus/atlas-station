const fs=require('fs');
const p='E:/atlas-station/.atlas/context-mycelium/crystals.ndjson';
if(!fs.existsSync(p)){console.log('no crystals file');process.exit(0)}
const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
let solved=0,other=0; const samples=[];
for(const l of lines){
  try{
    const j=JSON.parse(l);
    const s=(JSON.stringify(j)||'').toLowerCase();
    if(s.includes('solved')||s.includes('sealed')||s.includes('"status":"done"')||s.includes('"status":"complete"')){
      solved++;
      if(samples.length<10){
        samples.push((j.id||j.ts||'?')+' :: '+(j.topic||j.label||j.summary||Object.keys(j).join(',')).toString().slice(0,110));
      }
    } else other++;
  }catch(e){ other++; }
}
console.log('total lines:',lines.length,'| solved-ish:',solved,'| other:',other);
samples.forEach(s=>console.log(' -',s));
