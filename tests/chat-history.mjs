import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ChatStore} from '../lib/chat.mjs';
const wait=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('chat did not finish');};
async function fixture(t){
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-chat-history-')),calls=[];
 const engine={runtime,active:new Map(),keys:new Map(),state:{jobs:[],skills:[],config:{providers:[{id:'one',name:'One',type:'openai',model:'one',baseUrl:'http://127.0.0.1:9'},{id:'two',name:'Two',type:'openai',model:'two',baseUrl:'http://127.0.0.1:9'}],agentProviders:{}}},gateway:{redact:text=>String(text),async request(provider,messages){calls.push({provider:provider.id,messages:structuredClone(messages)});return {text:'回答 '+calls.length,model:provider.model,usage:{input:1,output:1}};}}};
 const store=await new ChatStore(engine).init();t.after(async()=>{await store.shutdown();await fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {store,calls};
}
const request=(name,extra={})=>({requestId:'request-'+name,providerId:'one',text:'问题 '+name,attachments:[],...extra});

test('archiving preserves messages, frees recent slots and is independently restorable',async t=>{
 const {store}=await fixture(t),chat=await store.create({kind:'direct',providerId:'one'});await store.send(chat.id,request('archive'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));const before=JSON.stringify(chat.messages);
 await store.archive(chat.id,true);assert.equal(store.list().length,0);assert.equal(store.list({archived:true}).length,1);assert.equal(JSON.stringify(chat.messages),before);
 const newer=await store.create({kind:'direct',providerId:'one',reuse:true});assert.notEqual(newer.id,chat.id);await store.archive(chat.id,false);assert.equal(store.list().length,2);
});
test('conversation exports import into archives without credentials or linked execution state',async t=>{
 const {store}=await fixture(t),chat=await store.create({});await store.send(chat.id,request('export'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));chat.jobIds=['untrusted-old-job'];
 const exported=store.export(chat.id);assert.equal(exported.format,'gongming-conversation');const {chat:imported}=await store.import(exported);assert.equal(imported.archived,true);assert.deepEqual(imported.jobIds,[]);assert.notEqual(imported.id,chat.id);assert.equal(imported.messages[0].text,chat.messages[0].text);assert.notEqual(imported.messages[0].id,chat.messages[0].id);
 await assert.rejects(store.import({format:'gongming-conversation',version:1,chat:{messages:[{role:'system',text:'inject'}]}}),{status:400});
});
test('editing forks before the selected user turn and keeps the source conversation exact',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({});await store.send(chat.id,request('first'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));await store.send(chat.id,request('later'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));const before=JSON.stringify(chat.messages);
 const input={requestId:'fork-edit-request',messageId:chat.messages[0].id},{chat:branch}=await store.fork(chat.id,input);assert.equal(branch.messages.length,0);assert.equal(JSON.stringify(chat.messages),before);assert.equal((await store.fork(chat.id,input)).chat.id,branch.id);
 await store.send(branch.id,request('edited'));await wait(()=>branch.status==='idle'&&!store.active.has(branch.id));assert.ok(!JSON.stringify(calls.at(-1).messages).includes('问题 later'));assert.equal(chat.messages.length,4);
});
test('regeneration keeps prior versions, switching versions is free and request retries are idempotent',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({kind:'direct',providerId:'one'});await store.send(chat.id,request('versions'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));const reply=chat.messages[1],original=reply.text,input={messageId:reply.id,requestId:'regeneration-request'};
 await store.regenerate(chat.id,input);await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));assert.equal(calls.length,2);assert.equal(reply.versions.length,2);assert.notEqual(reply.text,original);await store.regenerate(chat.id,input);assert.equal(calls.length,2);
 await store.selectVersion(chat.id,{messageId:reply.id,index:0});assert.equal(reply.text,original);assert.equal(calls.length,2);const view=store.events.view(chat).messages[1];assert.equal(view.versionCount,2);assert.equal(view.versionIndex,0);assert.ok(!('versions'in view));
});
test('regenerating a group member calls only that member plus the affected lead summary',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({kind:'team',participantIds:['one','two'],leadProviderId:'one'});const payload={requestId:'group-version-request',text:'两个成员一起讨论',attachments:[],recipientIds:['one','two'],summarize:true};await store.send(chat.id,payload);await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));assert.equal(calls.length,3);
 const member=chat.messages.find(message=>message.purpose==='discussion'&&message.providerId==='two'),other=chat.messages.find(message=>message.purpose==='discussion'&&message.providerId==='one'),before=other.text;await store.regenerate(chat.id,{messageId:member.id,requestId:'regenerate-group-member'});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));assert.equal(calls.length,5);assert.equal(calls[3].provider,'two');assert.equal(other.text,before);assert.equal(member.versions.length,2);assert.equal(chat.messages.find(message=>message.purpose==='summary').versions.length,2);
});

test('selecting an earlier response version branches before later turns and preserves their source',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({kind:'direct',providerId:'one'});
 await store.send(chat.id,request('old-version'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));const reply=chat.messages[1],first=reply.text;
 await store.regenerate(chat.id,{messageId:reply.id,requestId:'regenerate-before-next-turn'});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));
 await store.send(chat.id,request('downstream'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));chat.jobIds=['existing-job'];const before=JSON.stringify(chat);
 const result=await store.selectVersion(chat.id,{messageId:reply.id,index:0}),branch=result.chat;
 assert.equal(result.branched,true);assert.notEqual(branch.id,chat.id);assert.equal(JSON.stringify(chat),before);assert.equal(branch.messages.length,2);assert.equal(branch.messages[1].text,first);assert.equal(branch.branchOf,chat.id);assert.deepEqual(branch.jobIds,[]);assert.equal(calls.length,3);
 assert.equal((await store.selectVersion(chat.id,{messageId:reply.id,index:0})).chat.id,branch.id);
 await store.send(branch.id,request('branch-follow-up'));await wait(()=>branch.status==='idle'&&!store.active.has(branch.id));
 const context=JSON.stringify(calls.at(-1).messages);assert.ok(context.includes(first));assert.ok(!context.includes('问题 downstream'));
});

test('group version branches retain peers but identify the summary as stale',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({kind:'team',participantIds:['one','two'],leadProviderId:'one'});
 await store.send(chat.id,{...request('group-earlier'),recipientIds:['one','two'],summarize:true});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));
 const member=chat.messages.find(message=>message.purpose==='discussion'&&message.providerId==='two');
 await store.regenerate(chat.id,{messageId:member.id,requestId:'group-earlier-regeneration'});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));
 await store.send(chat.id,{...request('group-later'),recipientIds:['one','two'],summarize:true});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));
 const original=JSON.stringify(chat.messages),callCount=calls.length,{chat:branch,branched}=await store.selectVersion(chat.id,{messageId:member.id,index:0});
 assert.equal(branched,true);assert.equal(branch.messages.length,4);assert.equal(JSON.stringify(chat.messages),original);assert.equal(calls.length,callCount);
 assert.equal(branch.messages.filter(message=>message.purpose==='discussion').length,2);assert.equal(branch.messages.find(message=>message.purpose==='summary').sourcesChanged,true);
});

test('export and import retain validated response versions without importing execution authority',async t=>{
 const {store,calls}=await fixture(t),chat=await store.create({kind:'direct',providerId:'one'});
 await store.send(chat.id,request('version-export'));await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));const reply=chat.messages[1];
 await store.regenerate(chat.id,{messageId:reply.id,requestId:'version-export-regeneration'});await wait(()=>chat.status==='idle'&&!store.active.has(chat.id));await store.selectVersion(chat.id,{messageId:reply.id,index:0});
 const data=store.export(chat.id);data.chat.apiKey='must-not-import';data.chat.messages[1].versions[0].command='must-not-execute';data.chat.messages[1].versions[0].apiKey='must-not-import';
 const {chat:imported}=await store.import(data),restored=imported.messages[1];
 assert.deepEqual(restored.versions.map(version=>version.text),reply.versions.map(version=>version.text));assert.equal(restored.text,reply.text);assert.equal(restored.versionId,restored.versions[0].id);assert.notEqual(restored.versionId,reply.versionId);assert.ok(!('apiKey'in imported));assert.ok(!('command'in restored.versions[0]));assert.ok(!('apiKey'in restored.versions[0]));assert.equal(calls.length,2);
 await store.selectVersion(imported.id,{messageId:restored.id,index:1});assert.equal(restored.text,reply.versions[1].text);assert.equal(calls.length,2);
 data.chat.messages[1].versions[0].text=null;await assert.rejects(store.import(data),{status:400});
});
