import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readAuditLog} from '../lib/audit-log.mjs';

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
