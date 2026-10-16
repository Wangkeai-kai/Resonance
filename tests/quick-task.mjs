import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../lib/engine.mjs';
import {ChatStore} from '../lib/chat.mjs';
import {quickTaskInput} from '../lib/quick-task.mjs';

test('one sentence selects a template and preserves requested PPT page count',()=>{
  assert.equal(quickTaskInput('做一个咖啡店网站').workflowId,'website');
  assert.equal(quickTaskInput('写一份本周的工作报告').workflowId,'document');
  assert.equal(quickTaskInput('安排下一阶段的项目计划').workflowId,'project');
  assert.equal(quickTaskInput('修复现有代码的登录问题').workflowId,'code');
  assert.equal(quickTaskInput('做一份 12 页的 PPT').templateValues.slideCount,'12');
  assert.throws(()=>quickTaskInput('做一份 30 页 PPT'),/4–20/);
});
test('duplicate start requests create one job, survive reload, preserve role mappings',async t=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-quick-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const engine=new Engine(runtime,{dataDirectory:runtime});engine.capabilities.git=true;engine.gateway.provider=()=>({id:'a'});let starts=0;engine.run=async()=>{starts++;};engine.git=async()=> 'a'.repeat(40);engine.state.config.agentProviders={orchestrator:'a',developer:'b'};
  const chats=await new ChatStore(engine).init(),chat=await chats.create();
  const input={requestId:'quick-request-12345',text:'做一份 6 页的 PPT'};
  const results=await Promise.all([chats.startTask(chat.id,input),chats.startTask(chat.id,input)]);
  assert.equal(engine.state.jobs.length,1);assert.equal(starts,1);assert.equal(results[0].job.id,results[1].job.id);assert.equal(chat.jobIds.length,1);assert.equal(engine.state.jobs[0].workflow.values.slideCount,'6');assert.deepEqual(engine.state.jobs[0].configSnapshot.agentProviders,{orchestrator:'a',developer:'b'});
  const again=new ChatStore(engine);await again.init();await again.startTask(chat.id,input);assert.equal(starts,1);
  await assert.rejects(again.startTask(chat.id,{...input,text:'做一个新网站'}),{code:'request_conflict'});assert.equal(starts,1);
});
test('required setup failure does not create or attach a task',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-quick-missing-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50}));const engine=new Engine(runtime,{dataDirectory:runtime});const store=await new ChatStore(engine).init(),chat=await store.create();await assert.rejects(store.startTask(chat.id,{requestId:'quick-missing-123',text:'做一个网页'}),{code:'configuration_required'});assert.equal(engine.state.jobs.length,0);assert.equal(chat.jobIds,undefined);
});

test('question submitted in task mode uses one real chat request and never creates a job',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'resonance-question-')),requests=[];
 const engine={runtime,keys:new Map(),active:new Map(),state:{jobs:[],skills:[],config:{providers:[{id:'lead',name:'Lead',type:'openai',model:'fixture',baseUrl:'http://127.0.0.1:9'}],agentProviders:{orchestrator:'lead'}}},gateway:{redact:String,async request(provider,messages){requests.push({provider:provider.id,messages});return {text:'当前职责都指向主模型。',model:provider.model,usage:{input:1,output:1}};}}};
 const store=await new ChatStore(engine).init();t.after(async()=>{await store.shutdown();await fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const chat=await store.create(),payload={requestId:'question-task-request',text:'为什么没有调用kimi'};
 const result=await store.startTask(chat.id,payload);assert.equal(result.asConversation,true);assert.equal(engine.state.jobs.length,0);
 for(let i=0;i<100&&store.active.has(chat.id);i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(requests.length,1);assert.equal(chat.messages.length,2);assert.equal(chat.messages[0].text,payload.text);assert.equal(chat.messages[1].status,'completed');
 await store.startTask(chat.id,payload);assert.equal(requests.length,1);assert.equal(chat.messages.length,2);
});
