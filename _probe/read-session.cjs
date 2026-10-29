const fs=require('fs'),z=require('zlib');
const p=process.argv[1];
const raw=z.zstdDecompressSync(fs.readFileSync(p)).toString('utf8');
const lines=raw.split('\n').filter(Boolean);
console.log('lines',lines.length);
let users=[];
for(const l of lines){ let o; try{o=JSON.parse(l)}catch(e){continue}
  const role=o.role||o.type||(o.message&&o.message.role);
  if(role==='user'){ let t=typeof o.content==='string'?o.content:JSON.stringify(o.content||o.message&&o.message.content); users.push(t.slice(0,600)); }
}
console.log('userMsgs',users.length);
users.slice(-25).forEach((t,i)=>console.log('---U'+(users.length-25+i)+'---\n'+t));
