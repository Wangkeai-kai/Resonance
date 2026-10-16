import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AuditLog,readAuditLog} from '../lib/audit-log.mjs';

async function fixture(t,records){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-audit-page-')),file=path.join(directory,'audit.jsonl');
 t.after(()=>fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30}));
 if(records!==undefined)await fs.writeFile(file,records.map(item=>JSON.stringify(item)).join('\n')+'\n');return file;
}

test('audit keeps a bounded chronological window and scans earlier history for recovery evidence',async t=>{
 const records=Array.from({length:3005},(_,index)=>({id:'audit-'+index,action:index===0?'job_created':'event',jobId:index%2?'one':'two'})),file=await fixture(t,records);
 const latest=await readAuditLog(file);assert.equal(latest.items.length,1000);assert.equal(latest.items[0].id,'audit-2005');assert.equal(latest.items.at(-1).id,'audit-3004');assert.equal(latest.hasMore,true);assert.equal(latest.hasJobs,true);
 const older=await readAuditLog(file,{before:latest.items[0].id,limit:1000});assert.equal(older.items[0].id,'audit-1005');assert.equal(older.items.at(-1).id,'audit-2004');assert.equal(older.hasMore,true);
 const first=await readAuditLog(file,{before:'audit-0'});assert.deepEqual(first.items,[]);assert.equal(first.hasMore,false);
});

test('job filtering and pagination share the global audit cursor without duplicate records',async t=>{
 const file=await fixture(t,Array.from({length:14},(_,index)=>({id:'audit-'+index,jobId:index%2?'one':'two',action:'event'})));
 const latest=await readAuditLog(file,{jobId:'one',limit:3});assert.deepEqual(latest.items.map(item=>item.id),['audit-9','audit-11','audit-13']);assert.equal(latest.hasMore,true);
 const older=await readAuditLog(file,{jobId:'one',limit:3,before:'audit-9'});assert.deepEqual(older.items.map(item=>item.id),['audit-3','audit-5','audit-7']);
 const first=await readAuditLog(file,{jobId:'one',limit:3,before:'audit-3'});assert.deepEqual(first.items.map(item=>item.id),['audit-1']);assert.equal(first.hasMore,false);
 await assert.rejects(readAuditLog(file,{before:'missing-cursor'}),{status:409});
});

test('missing log is empty but malformed saved history is never silently discarded',async t=>{
 const file=await fixture(t);assert.deepEqual(await readAuditLog(file),{items:[],hasJobs:false,hasMore:false});
 await fs.writeFile(file,'{"id":"valid"}\n{"partial":');await assert.rejects(readAuditLog(file),SyntaxError);
 await fs.writeFile(file,'[]\n');await assert.rejects(readAuditLog(file),/Invalid audit record/);
 for(const limit of [0,1001,1.5,'10'])await assert.rejects(readAuditLog(file,{limit}),/Invalid audit page size/);
});

test('rotation keeps chronological pages across segments and durably retains job evidence after pruning',async t=>{
 const file=await fixture(t),log=new AuditLog(file,{maxBytes:512,maxArchives:2});
 for(let i=0;i<90;i++)await log.append({id:'entry-'+i,action:i===0?'job_created':'event',jobId:i%2?'one':'two',text:'审计条目跨分段'});
 const segments=await log.segments();assert.equal(segments.length,2);
 for(const segment of [...segments,file])assert.ok((await fs.stat(segment)).size<=512);
 const page=await log.read({limit:5});assert.deepEqual(page.items.map(x=>x.id),['entry-85','entry-86','entry-87','entry-88','entry-89']);assert.equal(page.hasJobs,true);
 const older=await log.read({limit:5,before:'entry-85'});assert.equal(older.items.at(-1).id,'entry-84');
 const recovered=await new AuditLog(file).read();assert.equal(recovered.hasJobs,true);assert.ok(!recovered.items.some(x=>x.action==='job_created'));
 await assert.rejects(log.read({before:'entry-0'}),{status:409});
 assert.ok(JSON.parse(await fs.readFile(file+'.meta.json','utf8')).prunedSegments>0);
});

test('warm startup reads the tail rather than rescanning a large history and preserves split UTF-8',async t=>{
 const file=await fixture(t,Array.from({length:6000},(_,i)=>({id:'line-'+i,action:i===0?'job_created':'event',text:'中文字符'.repeat(12)})));
 await new AuditLog(file).init();
 let bytes=0;const log=new AuditLog(file,{onRead:n=>bytes+=n});
 const page=await log.read({limit:12});
 assert.equal(page.items[0].id,'line-5988');assert.equal(page.items.at(-1).text,'中文字符'.repeat(12));assert.equal(page.hasJobs,true);
 assert.ok(bytes<=65536,'Expected one tail block, read '+bytes);
});

test('damaged metadata and audit tails fail closed without overwriting evidence',async t=>{
 const file=await fixture(t,[{id:'one',action:'job_created'}]);await new AuditLog(file).init();
 await fs.appendFile(file,'{"partial":');const saved=await fs.readFile(file,'utf8');
 await assert.rejects(new AuditLog(file).read(),SyntaxError);assert.equal(await fs.readFile(file,'utf8'),saved);
 await fs.writeFile(file+'.meta.json','{}');await assert.rejects(new AuditLog(file).read(),/Invalid audit metadata/);
});
