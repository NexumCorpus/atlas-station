const fs=require('fs'),path=require('path');
function walk(dir,hits,depth){
  if(depth>6) return;
  let ents; try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch(e){return}
  for(const e of ents){
    if(e.name==='node_modules'||e.name==='.git'||e.name==='worktrees') continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) walk(p,hits,depth+1);
    else if(e.name==='deferred.ndjson') hits.push(p);
  }
}
const hits=[];
for(const root of ['E:/atlas-station','E:/station']) walk(root,hits,0);
console.log('FOUND FILES:',JSON.stringify(hits,null,1));
for(const p of hits){
  const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
  console.log('\n=== FILE',p,'| lines:',lines.length);
  const counts={}; const zomb=[];
  for(const l of lines){
    try{
      const j=JSON.parse(l);
      const k=(j.status||j.state||j.kind||'?');
      counts[k]=(counts[k]||0)+1;
      const s=JSON.stringify(j).toLowerCase();
      if(s.includes('crystallization')||(s.includes('crystal')&&s.includes('repair'))) zomb.push(j);
    }catch(e){ counts['PARSE_ERR']=(counts['PARSE_ERR']||0)+1; }
  }
  console.log('status/state counts:',JSON.stringify(counts));
  console.log('crystallization-repair candidates:',zomb.length);
  zomb.slice(0,30).forEach((j,i)=>{
    console.log(' ['+i+']',JSON.stringify({
      id:j.id||j.deferId||j.tid,
      title:(j.task||j.title||j.text||j.description||'').toString().slice(0,90),
      status:j.status,state:j.state,
      created:j.createdAt||j.ts,
      keys:Object.keys(j).slice(0,12).join(',')
    }));
  });
}
