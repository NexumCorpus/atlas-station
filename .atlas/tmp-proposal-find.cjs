const fs=require('fs');
const cands=[
 'E:/atlas-station/.atlas/memory/proposals.ndjson',
 'E:/atlas-station/.atlas/proposals.ndjson',
 'E:/atlas-station/.atlas/memory/facts.ndjson'
];
for(const p of cands){
  if(!fs.existsSync(p)) continue;
  const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
  for(const l of lines){
    try{
      const j=JSON.parse(l);
      const s=(j.description||j.text||j.content||JSON.stringify(j)).toLowerCase();
      if(s.includes('crystal')&&(s.includes('sweep')||s.includes('solved'))){
        console.log('FILE:',p);
        console.log(JSON.stringify(j,null,1).slice(0,1500));
        console.log('---');
      }
    }catch(e){}
  }
}
