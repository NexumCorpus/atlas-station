const fs=require('fs');
const lines=fs.readFileSync('E:/atlas-station/memory/deferred.ndjson','utf8').trim().split('\n').filter(Boolean);
const groups={queued:[],unknown:[],claimedSample:[],retired:[]};
lines.forEach((l,i)=>{
  try{
    const j=JSON.parse(l);
    const st=j.state||j.status;
    if(st==='queued') groups.queued.push({i,id:j.id,title:(j.task||'').slice(0,100),created:j.ts});
    else if(st==='claimed'&&groups.claimedSample.length<5) groups.claimedSample.push({i,id:j.id,title:(j.task||'').slice(0,80),created:j.ts});
    else if(!st) groups.unknown.push({i,id:j.id,keys:Object.keys(j).join(','),raw:l.slice(0,200)});
    else if(st==='retired') groups.retired.push({i,id:j.id,reason:(j.reason||j.resolution||'').slice(0,80)});
  }catch(e){}
});
console.log('QUEUED:',JSON.stringify(groups.queued,null,1));
console.log('UNKNOWN:',JSON.stringify(groups.unknown,null,1));
console.log('CLAIMED sample(5 of '+lines.filter(l=>{try{return JSON.parse(l).state==='claimed'}catch(e){return false}}).length+'):',JSON.stringify(groups.claimedSample,null,1));
console.log('RETIRED:',JSON.stringify(groups.retired,null,1));
