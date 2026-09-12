import {scanClaudeLogs} from '../../src/usage.ts';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'usage-memory-')); const file=join(root,'session.jsonl');
writeFileSync(file,'');
for(let n=0;n<48;n++) {
appendFileSync(file,'{"type":"user","message":{"content":[{"type":"tool_result","content":"');
for(let i=0;i<8;i++)appendFileSync(file,'x'.repeat(1024*1024));
appendFileSync(file,'"}]}}\n');
}
appendFileSync(file,JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{id:'m1',model:'claude-sonnet-4',usage:{input_tokens:10,output_tokens:5}}}));
Bun.gc(true);
try { const records=scanClaudeLogs(root,0,Date.now()+1000); console.log(JSON.stringify({peakBytes:process.resourceUsage().maxRSS,records:records.length,inputTokens:records[0]?.inputTokens})); }
finally {rmSync(root,{recursive:true,force:true});}
