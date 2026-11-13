const fs=require('fs');const base='/usr/local/lib/node_modules/n8n/node_modules/.pnpm/';
const d=fs.readdirSync(base).find(x=>x.startsWith('flatted@'));const {parse}=require(base+d+'/node_modules/flatted');
const o=parse(fs.readFileSync('/tmp/exec.txt','utf8'));const rd=o.resultData;
if(rd.error) console.log('ERRO GERAL:', rd.error.message, rd.error.description||'');
for(const [n,runs] of Object.entries(rd.runData)){for(const r of runs){
  const out=r.data&&r.data.main?r.data.main.map(x=>x?x.length:0):null;
  console.log(`[${n}] ${r.executionStatus} saidas=${JSON.stringify(out)}`, r.error?('ERRO: '+r.error.message+' '+(r.error.description||'')):'');
  if(process.argv[2]==='v'&&r.data&&r.data.main){for(const s of r.data.main){if(s&&s[0])console.log('   ', JSON.stringify(s[0].json).slice(0,400));}}
}}
if(process.argv[2]==='b'){for(const [n,runs] of Object.entries(rd.runData)){for(const r of runs){if(r.data&&r.data.main)for(const s of r.data.main){if(s&&s[0]&&s[0].binary)console.log('BIN',n,JSON.stringify(Object.fromEntries(Object.entries(s[0].binary).map(([k,v])=>[k,{mimeType:v.mimeType,fileName:v.fileName,id:v.id,size:v.fileSize,hasData:!!v.data}]))));}}}}
