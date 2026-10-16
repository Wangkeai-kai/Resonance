import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {executeAgentWork,indexRepository} from '../lib/agent-work.mjs';
import {safePath} from '../lib/safety.mjs';
async function fixture(t,responses){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-agent-loop-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));let calls=0;const inputs=[];
 const task={id:'developer',worktree:root},job={id:'job-loop'};
 const engine={active:new Map(),async persist(){},async record(){},async model(_job,_task,_instructions,input){inputs.push(input);const result=responses[calls++];if(!result)throw Error('unexpected model call');return structuredClone(result);},async writeFiles(_job,target,files){target.files||=[];for(const file of files){const absolute=await safePath(root,file.path,{writing:true});await fs.mkdir(path.dirname(absolute),{recursive:true});await fs.writeFile(absolute,file.content);target.files=target.files.filter(item=>item.path!==file.path).concat(file);}}};
 return {root,task,job,engine,inputs,get calls(){return calls;}};
}
test('iterative batches deliver more than a single twelve-file response',async t=>{
 const files=offset=>Array.from({length:21},(_,i)=>({path:'src/file-'+(offset+i)+'.js',content:'export const value = '+(offset+i)}));
 const f=await fixture(t,[{summary:'first batch',files:files(0),done:false},{summary:'complete',files:files(21),done:true}]);const result=await executeAgentWork(f.engine,f.job,f.task,'Implement',{});
 assert.equal(result.files.length,42);assert.equal(result.iterations,2);assert.equal(f.calls,2);assert.equal(f.task.workCheckpoint.finished,true);
});
test('accepted model output is reused after an interrupted file action without a new call',async t=>{
 const f=await fixture(t,[{summary:'finish',files:[{path:'result.md',content:'preserve this paid output'}],done:true}]);const original=f.engine.writeFiles;let fail=true;f.engine.writeFiles=async(...args)=>{if(fail){fail=false;throw Error('temporary interruption');}return original(...args);};
 await assert.rejects(executeAgentWork(f.engine,f.job,f.task,'Implement',{}),/temporary interruption/);assert.equal(f.calls,1);assert.ok(f.task.workCheckpoint.accepted);
 const restored=JSON.parse(JSON.stringify(f.task));await executeAgentWork(f.engine,f.job,restored,'Implement',{});assert.equal(f.calls,1);assert.equal(await fs.readFile(path.join(f.root,'result.md'),'utf8'),'preserve this paid output');
});
test('repository index can expose files beyond the old hundred-file context and read them on demand',async t=>{
 const f=await fixture(t,[{summary:'inspect',done:false,actions:[{tool:'read',path:'src/file-149.js'}]},{summary:'finish',done:true,files:[{path:'README.md',content:'done'}]}]);await fs.mkdir(path.join(f.root,'src'));for(let i=0;i<150;i++)await fs.writeFile(path.join(f.root,'src/file-'+i+'.js'),'value '+i);
 const index=await indexRepository(f.root);assert.equal(index.paths.length,150);await executeAgentWork(f.engine,f.job,f.task,'Implement',{});assert.equal(f.inputs[1].observations[0].results[0].result.content,'value 149');assert.equal(f.inputs[0].indexCoverage.available,150);
});
test('agent tools cannot run shell commands or read outside the worktree',async t=>{
 const f=await fixture(t,[{done:false,actions:[{tool:'shell',command:'arbitrary'}]}]);await assert.rejects(executeAgentWork(f.engine,f.job,f.task,'Implement',{}),/未授权工具/);
 f.task.workCheckpoint=null;f.engine.model=async()=>({done:false,actions:[{tool:'read',path:'../private.txt'}]});await assert.rejects(executeAgentWork(f.engine,f.job,f.task,'Implement',{}),/Invalid|Unsafe|path/i);
});
