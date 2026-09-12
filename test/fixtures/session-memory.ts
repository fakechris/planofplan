import {openMemoryDb} from "../../src/db.ts";
import {collectSessionCatalog} from "../../src/sessions.ts";
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";
const root=mkdtempSync(join(tmpdir(),"pofp-memory-")), claude=join(root,"claude");mkdirSync(claude);
const path=join(claude,"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
writeFileSync(path,JSON.stringify({type:"user",uuid:"u1",cwd:root,message:{content:[{type:"text",text:"memory regression start"}]}})+"\n");
appendFileSync(path,'{"type":"user","message":{"content":[{"type":"tool_result","content":"');
for(let i=0;i<64;i++)appendFileSync(path,"x".repeat(1048576));
appendFileSync(path,'"}]}}\n'+JSON.stringify({type:"user",uuid:"u2",cwd:root,message:{content:[{type:"text",text:"memory regression tail"}]}})+"\n");
Bun.gc(true);const store=openMemoryDb();
try{await collectSessionCatalog(store,{since:0,until:Date.now()+1000,codexRoot:join(root,"absent"),claudeRoots:[claude],opencodeRoot:root,zcodeRoot:root,droidRoot:root,kimiRoot:root,grokRoot:root,dshRoot:root,antigravityRoot:root,ampRoot:root,messageRetentionDays:0});
const peak=process.resourceUsage().maxRSS; console.log(JSON.stringify({peakBytes:peak,memory:process.memoryUsage(),messages:store.countSessionMessages("claude:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")}));
if(peak>640*1024*1024)process.exitCode=1;
}finally{store.close();rmSync(root,{recursive:true,force:true});}
