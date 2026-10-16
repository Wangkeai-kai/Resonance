import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Engine} from '../lib/engine.mjs';
import {ChatStore} from '../lib/chat.mjs';
import {ChatGPTConnection} from '../lib/chatgpt.mjs';
import {saveSnapshot,replaceSnapshotFile} from '../lib/local-snapshot.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(t){const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-persistence-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50}));return {runtime,engine:new Engine(root,{dataDirectory:runtime})};}
const state=()=>({version:1,config:{providers:[],agentProviders:{},projectPath:''},jobs:[],analyses:[],skills:[],approvals:[]});
test('unknown and malformed saved states retain exact original bytes',async t=>{
 const {runtime,engine}=await fixture(t);for(const raw of ['{broken',JSON.stringify({...state(),version:9}),JSON.stringify({...state(),config:{}})]){
 await fs.writeFile(path.join(runtime,'state.json'),raw);await assert.rejects(engine.init(),{code:'state_invalid'});assert.equal(await fs.readFile(path.join(runtime,'state.json'),'utf8'),raw);await assert.rejects(fs.access(path.join(runtime,'state.previous.json')));
 }
});
test('missing or empty primary with historical audit cannot reset workspace',async t=>{
 const {runtime,engine}=await fixture(t);await fs.writeFile(path.join(runtime,'audit.jsonl'),JSON.stringify({action:'job_created',jobId:'job-old'})+'\n');
 await assert.rejects(engine.init(),{code:'history_recovery_required'});await assert.rejects(fs.access(path.join(runtime,'state.json')));
 const raw=JSON.stringify(state());await fs.writeFile(path.join(runtime,'state.json'),raw);await assert.rejects(engine.init(),{code:'history_recovery_required'});assert.equal(await fs.readFile(path.join(runtime,'state.json'),'utf8'),raw);
});
test('missing primary with a previous snapshot or worktree refuses initialization',async t=>{
 const {runtime,engine}=await fixture(t);await fs.writeFile(path.join(runtime,'state.previous.json'),JSON.stringify(state()));await assert.rejects(engine.init(),{code:'history_recovery_required'});
 await fs.unlink(path.join(runtime,'state.previous.json'));await fs.mkdir(path.join(runtime,'worktrees','job-old'));await assert.rejects(engine.init(),{code:'history_recovery_required'});await assert.rejects(fs.access(path.join(runtime,'state.json')));
});
test('snapshots preserve previous version and unchanged saves do not rotate it',async t=>{
 const {runtime,engine}=await fixture(t);await engine.persist();engine.state.config.approvalMode='ask';await engine.persist();const previous=await fs.readFile(path.join(runtime,'state.previous.json'),'utf8');await engine.persist();assert.equal(await fs.readFile(path.join(runtime,'state.previous.json'),'utf8'),previous);
 const writes=[];for(let i=0;i<10;i++){engine.state.config.iteration=i;writes.push(engine.persist());}await Promise.all(writes);assert.equal(JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8')).config.iteration,9);assert.equal(JSON.parse(await fs.readFile(path.join(runtime,'state.previous.json'),'utf8')).config.iteration,8);
});

test('Windows sharing violations retry only atomic renames, preserving the exact destination',async()=>{
 const calls=[],waits=[];let attempts=0;
 await replaceSnapshotFile('saved.tmp','saved.json',{platform:'win32',wait:async ms=>waits.push(ms),rename:async(...args)=>{calls.push(args);if(attempts++<2)throw Object.assign(new Error('busy'),{code:'EPERM'});}});
 assert.deepEqual(calls,[['saved.tmp','saved.json'],['saved.tmp','saved.json'],['saved.tmp','saved.json']]);assert.deepEqual(waits,[20,40]);
});

test('persistent and non-sharing snapshot errors fail with the original error',async()=>{
 const denied=Object.assign(new Error('denied'),{code:'EACCES'});let attempts=0;
 await assert.rejects(replaceSnapshotFile('saved.tmp','saved.json',{platform:'win32',wait:async()=>{},rename:async()=>{attempts++;throw denied;}}),error=>error===denied);assert.equal(attempts,8);
 attempts=0;await assert.rejects(replaceSnapshotFile('saved.tmp','saved.json',{platform:'linux',wait:async()=>{},rename:async()=>{attempts++;throw denied;}}),error=>error===denied);assert.equal(attempts,1);
});
test('chat corruption and missing primary retain the previous conversation',async t=>{
 const {runtime,engine}=await fixture(t);const store=await new ChatStore(engine).init();await store.create({title:'保留这段对话'});await store.create({title:'第二段'});const backup=await fs.readFile(path.join(runtime,'chats.previous.json'),'utf8');await fs.writeFile(path.join(runtime,'chats.json'),'invalid');await assert.rejects(new ChatStore(engine).init(),{code:'chat_invalid'});assert.equal(await fs.readFile(path.join(runtime,'chats.previous.json'),'utf8'),backup);
 await fs.unlink(path.join(runtime,'chats.json'));await assert.rejects(new ChatStore(engine).init(),{code:'history_recovery_required'});assert.equal(await fs.readFile(path.join(runtime,'chats.previous.json'),'utf8'),backup);
});
test('second backend cannot touch snapshots before workspace owner rejection',async t=>{
 const {runtime}=await fixture(t);const owner=await new ChatGPTConnection(runtime).init();t.after(()=>owner.close());const original=JSON.stringify({...state(),marker:'untouched'});await fs.writeFile(path.join(runtime,'state.json'),original);await fs.writeFile(path.join(runtime,'state.previous.json'),'older-history');await fs.writeFile(path.join(runtime,'chats.json'),JSON.stringify({version:1,chats:[]}));
 const child=spawn(process.execPath,[path.join(root,'server.mjs'),'--port','49897'],{env:{...process.env,GONGMING_DATA_DIR:runtime},windowsHide:true});let stderr='';child.stderr.on('data',c=>stderr+=c);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.notEqual(code,0);assert.match(stderr,/workspace_in_use/);assert.equal(await fs.readFile(path.join(runtime,'state.json'),'utf8'),original);assert.equal(await fs.readFile(path.join(runtime,'state.previous.json'),'utf8'),'older-history');
});
test('partially recovered history cannot resume or replay approval',async t=>{
 const {engine}=await fixture(t);const job={id:'old',recoveryIncomplete:true,tasks:[{id:'tester'}]};engine.state.jobs=[job];engine.state.approvals=[{id:'old-approval',status:'pending',jobId:'old',taskId:'tester'}];for(const action of ['resume','retry','commit','merge','rollback'])await assert.rejects(engine.actions(job,action),{code:'history_read_only'});await assert.rejects(engine.run(job),{code:'history_read_only'});await assert.rejects(engine.decide('old-approval',true),{code:'history_read_only'});assert.equal(engine.state.approvals[0].status,'pending');
});
