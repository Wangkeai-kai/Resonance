import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../lib/engine.mjs';
import {expandCoordination} from '../lib/coordination.mjs';
import {ModelGateway} from '../lib/models.mjs';

test('specialist plans expand once, only for new code work; historical jobs retain their graph',()=>{
 const make=()=>({coordinationVersion:1,kind:'website',tasks:[{id:'orchestrator',status:'completed',result:{assignments:[{agentId:'frontend',objective:'Build UI'},{agentId:'backend',objective:'Build API'}]}},{id:'developer',status:'blocked',deps:['context','architect']}]});
 const job=make();assert.equal(expandCoordination(job),true);assert.deepEqual(job.tasks.find(t=>t.id==='developer').deps,['context','architect','frontend','backend']);assert.equal(expandCoordination(job),false);assert.equal(job.tasks.length,4);
 const old=make();delete old.coordinationVersion;assert.equal(expandCoordination(old),false);assert.equal(old.tasks.length,2);
 const ppt=make();ppt.kind='ppt';assert.equal(expandCoordination(ppt),false);
});
test('model routing keeps specialists optional and supports multiple companies and same-provider versions',()=>{
 const providers=['lead','front','back'].map(id=>({id,name:id,type:'openai',baseUrl:'http://localhost:1234/v1',model:id}));const config={providers,agentProviders:{orchestrator:'lead',frontend:'front',backend:'back'}};
 const gateway=new ModelGateway({config},new Map(),async()=>{});assert.equal(gateway.provider('frontend').id,'front');assert.equal(gateway.provider('backend').id,'back');delete config.agentProviders.frontend;assert.equal(gateway.provider('frontend').id,'lead');config.agentProviders.developer='back';assert.equal(gateway.provider('frontend').id,'back');
});
test('lead delegates actual isolated frontend/backend work and integrates only after both finish',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-team-'));const engine=await new Engine(tmp).init();
 t.after(async()=>{while(engine.active.size)await new Promise(r=>setTimeout(r,20));if(path.basename(tmp).startsWith('gongming-team-'))await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
 await engine.config({providers:['lead','front','back'].map(id=>({id,name:id,type:'openai',baseUrl:'http://localhost:1234/v1',model:id})),agentProviders:{orchestrator:'lead',frontend:'front',backend:'back'}});
 const calls=[];engine.gateway.request=async(provider,messages)=>{const agent=messages[0].content.match(/You are the (\w+) agent/)[1],input=JSON.parse(messages[1].content);calls.push({agent,provider:provider.id,input});let result={summary:'fixture'};
 if(agent==='orchestrator')result={summary:'Build site',requirements:[{id:'r1',text:'UI and API'}],assignments:[{agentId:'frontend',objective:'Implement interface'},{agentId:'backend',objective:'Implement API'}]};
 if(agent==='architect')result={summary:'Shared schema',interfaces:['GET /items -> []'],directoryStructure:['front.js','back.js']};
 if(agent==='frontend'||agent==='backend')result={summary:agent,files:[{path:agent==='frontend'?'front.js':'back.js',content:agent==='frontend'?'export const title="UI";':'export const items=[];'}]};
 if(agent==='developer'){assert.ok(input.files.some(f=>f.path==='front.js'));assert.ok(input.files.some(f=>f.path==='back.js'));result={summary:'integrated',files:[{path:'index.html',content:'<!doctype html><html><body><h1>Fixture interface</h1></body></html>'}]};}
 if(agent==='tester')result={files:[{path:'tests/site.test.js',content:'console.log("fixture")'}],command:{image:'node:22-alpine',argv:['node','--test']}};
 if(agent==='docs')result={files:[{path:'README.md',content:'# Fixture\n\nUI and API implementation.'}]};
 return {text:JSON.stringify(result),usage:{input:10,output:10},provider:provider.id,model:provider.model};};
 const job=await engine.create({brief:'Build a website with frontend and backend',kind:'website'});while(engine.active.size)await new Promise(r=>setTimeout(r,30));
 assert.equal(job.status,'awaiting_approval',JSON.stringify(job.tasks.map(t=>({id:t.id,error:t.error}))));assert.equal(calls.find(c=>c.agent==='frontend').provider,'front');assert.equal(calls.find(c=>c.agent==='backend').provider,'back');assert.equal(calls.find(c=>c.agent==='developer').provider,'lead');
 const dev=job.tasks.find(t=>t.id==='developer');assert.deepEqual(dev.modelAssignment,{providerId:'lead',name:'lead',model:'lead',role:'orchestrator'});for(const role of ['frontend','backend']){const task=job.tasks.find(t=>t.id===role);assert.notEqual(task.worktree,dev.worktree);assert.ok(task.completedAt<=dev.startedAt);assert.ok(calls.find(c=>c.agent===role).input.currentAssignment.objective);assert.equal(task.modelAssignment.role,role);assert.equal(task.modelAssignment.providerId,role==='frontend'?'front':'back');}
 assert.match(await fs.readFile(path.join(dev.worktree,'back.js'),'utf8'),/items/);assert.equal(engine.state.approvals[0].status,'pending');
});

async function identityFixture(t) {
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-identity-'));
 t.after(()=>fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const engine=new Engine(runtime,{dataDirectory:runtime});
 engine.state.config={providers:[{id:'current',name:'Current lead',type:'openai',baseUrl:'http://localhost:1234/v1',model:'current-v2'}],agentProviders:{orchestrator:'current'}};
 const task={id:'frontend',agentId:'frontend',status:'running'},job={id:'identity-job',budget:100000,tokens:{reserved:0,input:0,output:0},configSnapshot:{providers:[{id:'old',name:'Old lead',model:'old-v1'}],agentProviders:{orchestrator:'old'}},tasks:[task]};
 engine.state.jobs.push(job);
 return {runtime,engine,job,task};
}

test('actual provider identity is durable before inference and remains after a failed request',async t=>{
 const {runtime,engine,job,task}=await identityFixture(t);
 const expected={providerId:'current',name:'Current lead',model:'current-v2',role:'frontend'};
 let requests=0;
 engine.gateway.request=async provider=>{
  requests++;assert.equal(provider.id,'current');
  const saved=JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8'));
  assert.deepEqual(saved.jobs[0].tasks[0].modelAssignment,expected);
  throw new Error('fixture provider unavailable');
 };
 await assert.rejects(engine.model(job,task,'Review fixture',{}),/fixture provider unavailable/);
 assert.equal(requests,1);assert.deepEqual(task.modelAssignment,expected);
 engine.state.config.providers[0].name='Renamed after request';
 assert.equal(task.modelAssignment.name,'Current lead');
 assert.equal(job.configSnapshot.agentProviders.orchestrator,'old');
});

test('cached results keep model identity without issuing another request; budget rejection does not invent usage',async t=>{
 const {runtime,engine,job,task}=await identityFixture(t);let requests=0;
 engine.gateway.request=async()=>{requests++;return {text:'{"summary":"cached fixture"}',usage:{input:1,output:1}};};
 await engine.model(job,task,'Review fixture',{});delete task.modelAssignment;
 await engine.model(job,task,'Review fixture',{});
 assert.equal(requests,1);assert.equal(task.modelAssignment.providerId,'current');
 assert.equal(JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8')).jobs[0].tasks[0].modelAssignment.model,'current-v2');
 const freshTask={id:'backend',status:'running'};job.tasks.push(freshTask);job.budget=0;
 await assert.rejects(engine.model(job,freshTask,'Different work',{}),/token_budget_exceeded/);
 assert.equal(freshTask.modelAssignment,undefined);assert.equal(requests,1);
});

test('reused requirement analysis retains its original model after the configured lead changes',async t=>{
 const {engine,job}=await identityFixture(t);engine.state.jobs=[];engine.capabilities.git=true;
 engine.git=async()=> 'a'.repeat(40);engine.run=async()=>{};
 const original={id:'original',name:'Original planner',model:'original-v1',type:'openai',baseUrl:'http://localhost:1234/v1'};
 engine.state.analyses.push({id:'saved-analysis',brief:'Build a website fixture',kind:'website',createdAt:new Date().toISOString(),tokens:{...job.tokens},provider:original.id,model:original.model,providerSnapshot:original,result:{summary:'Saved analysis',requirements:[]}});
 const created=await engine.create({brief:'Build a website fixture',kind:'website',analysisId:'saved-analysis'});
 assert.equal(created.configSnapshot.agentProviders.orchestrator,'current');
 assert.deepEqual(created.tasks[0].modelAssignment,{providerId:'original',name:'Original planner',model:'original-v1',role:'orchestrator'});
 assert.equal(created.tasks[0].status,'completed');assert.equal(created.tasks[1].modelAssignment,undefined);
});
