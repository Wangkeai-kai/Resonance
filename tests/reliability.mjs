import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../lib/engine.mjs';
import {ChatStore} from '../lib/chat.mjs';

async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-reliability-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));return root;}
async function gitFixture(t){const root=await temporary(t),engine=await new Engine(root).init(),repo=path.join(root,'repo');await fs.mkdir(repo);const git=args=>engine.git(repo,args);await git(['init','--initial-branch=main']);await git(['config','user.name','Test']);await git(['config','user.email','test@example.invalid']);await fs.writeFile(path.join(repo,'base.md'),'base');await git(['add','--','base.md']);await git(['commit','-m','base']);await fs.writeFile(path.join(repo,'note.md'),'approved content');const job={id:'test-job',worktree:repo,projectPath:repo,branch:'main',artifacts:[{path:'note.md'}],tasks:[{id:'git',status:'completed',result:{commitMessage:'Reviewed note'}}]};engine.state.jobs.push(job);return {engine,repo,job,git};}

test('a failed initial save releases the job and allows explicit continuation',async t=>{
 const root=await temporary(t),engine=await new Engine(root).init(),job={id:'save-job',status:'queued',tasks:[{id:'tester',status:'queued',deps:[]}]};engine.state.jobs.push(job);const persist=engine.persist.bind(engine);let fail=true;engine.persist=async()=>{if(fail){fail=false;throw new Error('disk full');}return persist();};engine.executeTask=async(job,task)=>{task.status='awaiting_approval';return {};};await assert.rejects(engine.run(job),/disk full/);assert.equal(engine.active.has(job.id),false);assert.equal(job.status,'interrupted');await engine.run(job);assert.equal(job.status,'awaiting_approval');assert.equal(engine.active.size,0);
});

test('commit approval rejects changed contents before any Git mutation',async t=>{
 const {engine,repo,job,git}=await gitFixture(t),head=await git(['rev-parse','HEAD']);const {approval}=await engine.actions(job,'commit');await fs.writeFile(path.join(repo,'note.md'),'changed after approval');await engine.decide(approval.id,true);assert.equal(approval.status,'failed');assert.match(approval.result.error,/审批后/);assert.equal(await git(['rev-parse','HEAD']),head);assert.equal(await git(['diff','--cached','--name-only']),'');
});

test('commit approval rejects a changed index and changed HEAD',async t=>{
 const {engine,repo,job,git}=await gitFixture(t),head=await git(['rev-parse','HEAD']);const {approval}=await engine.actions(job,'commit');await fs.writeFile(path.join(repo,'extra.txt'),'unreviewed');await git(['add','--','extra.txt']);await engine.decide(approval.id,true);assert.equal(approval.status,'failed');assert.equal(await git(['rev-parse','HEAD']),head);assert.equal(await git(['diff','--cached','--name-only']),'extra.txt');const second=await engine.actions(job,'commit');await git(['commit','-m','outside change']);await engine.decide(second.approval.id,true);assert.equal(second.approval.status,'failed');assert.equal(job.commit,undefined);
});

test('an approved commit contains only listed files and preserves other staged work',async t=>{
 const {engine,repo,job,git}=await gitFixture(t);await fs.writeFile(path.join(repo,'extra.txt'),'already staged');await git(['add','--','extra.txt']);const {approval}=await engine.actions(job,'commit');await engine.decide(approval.id,true);assert.equal(approval.status,'approved',approval.result?.error);assert.equal(await git(['show','--pretty=format:','--name-only','HEAD']),'note.md');assert.equal(await git(['diff','--cached','--name-only']),'extra.txt');assert.ok(job.commit);
});

test('failure saving an approval decision never executes it or strands it as running',async t=>{
 const {engine,job,git}=await gitFixture(t),head=await git(['rev-parse','HEAD']),{approval}=await engine.actions(job,'commit'),persist=engine.persist.bind(engine);let fail=true;engine.persist=async()=>{if(fail){fail=false;throw new Error('save failed');}return persist();};await assert.rejects(engine.decide(approval.id,true),/save failed/);assert.equal(approval.status,'pending');assert.equal(await git(['rev-parse','HEAD']),head);await engine.decide(approval.id,true);assert.equal(approval.status,'approved');
});

test('group status distinguishes waiting summary from active requests and retains structured errors',async t=>{
 const runtime=await temporary(t);let release;const gate=new Promise(resolve=>release=resolve);const providers=['lead','peer'].map(id=>({id,name:id,model:id,type:'openai',baseUrl:'http://127.0.0.1:1/v1'}));const engine={runtime,keys:new Map(),active:new Map(),state:{config:{providers,agentProviders:{}},jobs:[],skills:[]},gateway:{redact:String,async request(provider){await gate;throw Object.assign(new Error('overloaded'),{code:'model_overloaded',status:429,providerCode:'engine_overloaded_error',retryAfterSeconds:12});}}};const store=await new ChatStore(engine).init();t.after(()=>store.shutdown());const chat=await store.create({kind:'team',participantIds:['lead','peer'],leadProviderId:'lead'});await store.send(chat.id,{requestId:'reliability-group',text:'hello',recipientIds:['lead','peer'],summarize:true});for(let i=0;i<100&&!chat.messages.find(m=>m.purpose==='discussion'&&m.startedAt);i++)await new Promise(r=>setTimeout(r,5));assert.equal(chat.messages.find(m=>m.purpose==='summary').phase,'waiting_members');assert.equal(chat.messages.find(m=>m.purpose==='summary').attempts,0);release();for(let i=0;i<100&&store.active.has(chat.id);i++)await new Promise(r=>setTimeout(r,5));const failed=chat.messages.find(m=>m.purpose==='discussion');assert.equal(failed.errorCode,'model_overloaded');assert.equal(failed.httpStatus,429);assert.equal(failed.retryAfterSeconds,12);assert.equal(chat.messages.at(-1).status,'skipped');const saved=JSON.parse(await fs.readFile(path.join(runtime,'chats.json')));assert.equal(saved.chats[0].messages[1].providerErrorCode,'engine_overloaded_error');
});
