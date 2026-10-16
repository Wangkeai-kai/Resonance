import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import {ChatStore,CHAT_LIMITS,validateChatAttachments,chatModelMessages} from '../lib/chat.mjs';
import {ModelGateway} from '../lib/models.mjs';

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=';
const pic={type:'image',name:'参考图.png',mimeType:'image/png',dataUrl:`data:image/png;base64,${PNG}`};
const request=(n,extra={})=>({requestId:`request-${n}`,providerId:'local',text:`第 ${n} 轮消息`,attachments:[],...extra});
const wait=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('mock response did not finish');};

async function fixture(t) {
  const requests=[],controls={failure:false,delay:null};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push({path:req.url,body});
    if(controls.delay)await controls.delay;
    res.setHeader('Content-Type','application/json');
    if(controls.failure){res.statusCode=400;res.end(JSON.stringify({error:'invalid image or model secret-test-key'}));return;}
    res.end(JSON.stringify(req.url.endsWith('/messages')?{content:[{type:'text',text:`Claude 回复 ${requests.length}`}],usage:{input_tokens:40,output_tokens:10}}:{choices:[{message:{content:`模型回复 ${requests.length}`}}],usage:{prompt_tokens:40,completion_tokens:10}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-chat-test-'));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const engine={runtime,active:new Map(),keys:new Map([['local','secret-test-key']]),state:{config:{providers:[{id:'local',name:'Local',baseUrl,type:'openai',model:'mock-vision'},{id:'claude',name:'Claude',baseUrl,type:'anthropic',model:'mock-claude'},{id:'missing',name:'缺少密钥',baseUrl:'https://invalid.example/v1',type:'openai',model:'remote'}],agentProviders:{}}}};
  engine.gateway=new ModelGateway(engine.state,engine.keys,async()=>{});
  const store=await new ChatStore(engine).init();
  t.after(async()=>{await store.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  return {engine,store,requests,controls,runtime};
}

test('multi-turn replies persist, retain previous turns and can change model',async t=>{
  const {store,requests,engine}=await fixture(t),chat=await store.create();
  const accepted=await store.send(chat.id,request(1,{text:'请帮我准备团队介绍'}));
  assert.equal(accepted.requestId,'request-1');assert.equal(chat.status,'running');assert.equal(engine.active.size,1);
  await wait(()=>chat.status==='idle');
  assert.equal(chat.messages.length,2);assert.equal(chat.messages[1].status,'completed');
  await store.send(chat.id,request(2,{providerId:'claude',text:'继续精简'}));await wait(()=>chat.status==='idle');
  assert.equal(requests[1].path,'/v1/messages');
  assert.deepEqual(requests[1].body.messages.map(m=>m.role),['user','assistant','user']);
  assert.equal(requests[1].body.messages[0].content,'请帮我准备团队介绍');
  assert.equal(chat.messages.at(-1).usage.input,40);assert.equal(engine.active.size,0);
  const reloaded=await new ChatStore(engine).init();
  assert.equal(reloaded.get(chat.id).messages.length,4);assert.equal(reloaded.list()[0].title,'请帮我准备团队介绍');
});

test('chat selects a relevant builtin and retains its reference with the reply',async t=>{
  const {store,requests}=await fixture(t),chat=await store.create();
  await store.send(chat.id,request('skill-route',{text:'帮我整理 PPT 的大纲'}));
  await wait(()=>chat.status==='idle');
  const system=requests[0].body.messages[0].content;
  assert.match(system,/PPT 内容与版式/);
  assert.ok(!system.includes('网站设计与交互'));
  assert.equal(chat.messages.at(-1).appliedSkills[0].id,'builtin-presentation');
});

test('older saved tasks appear once in the new conversational workspace',async t=>{
  const {engine}=await fixture(t);engine.state.jobs=[{id:'job-legacy',brief:'继续之前的 PPT',status:'awaiting_approval'}];
  const first=await new ChatStore(engine).init();assert.equal(first.chats.filter(c=>c.jobIds?.includes('job-legacy')).length,1);
  const second=await new ChatStore(engine).init();assert.equal(second.chats.filter(c=>c.jobIds?.includes('job-legacy')).length,1);assert.equal(engine.state.jobs[0].status,'awaiting_approval');
});

test('request id makes pending/completed duplicates free and rejects changed content',async t=>{
  const {store,requests,controls}=await fixture(t),chat=await store.create();let release;
  controls.delay=new Promise(resolve=>{release=resolve;});
  const result=await store.send(chat.id,request(10));
  assert.equal(result.chat.status,'running');await wait(()=>requests.length===1);
  assert.equal((await store.send(chat.id,request(10))).reused,true);
  await assert.rejects(store.send(chat.id,request(10,{text:'换一段内容'})),error=>error.code==='chat_request_conflict');
  await assert.rejects(store.send(chat.id,request(11)),error=>error.code==='chat_busy');
  await assert.rejects(store.remove(chat.id),error=>error.code==='chat_busy');
  assert.equal(requests.length,1);release();await wait(()=>chat.status==='idle');
  assert.equal((await store.send(chat.id,request(10))).reused,true);assert.equal(requests.length,1);
});

test('failed reply requires explicit retry and provider errors redact in-memory keys',async t=>{
  const {store,requests,controls}=await fixture(t),chat=await store.create();
  controls.failure=true;await store.send(chat.id,request(20));await wait(()=>chat.status==='idle');
  assert.equal(chat.messages.at(-1).status,'failed');assert.ok(!chat.messages.at(-1).error.includes('secret-test-key'));
  await store.send(chat.id,request(20));assert.equal(requests.length,1);
  controls.failure=false;await store.send(chat.id,request(20,{retry:true}));await wait(()=>chat.status==='idle');
  assert.equal(chat.messages.length,2);assert.equal(chat.messages.at(-1).attempts,2);assert.equal(chat.messages.at(-1).status,'completed');assert.equal(requests.length,2);
});

test('invalid or missing model configuration does not append a message or call a model',async t=>{
  const {store,requests}=await fixture(t),chat=await store.create();
  for(const providerId of ['missing','unknown'])await assert.rejects(store.send(chat.id,request(30,{providerId})),error=>error.code==='configuration_required');
  assert.equal(chat.messages.length,0);assert.equal(requests.length,0);
});

test('images have provider-native blocks and URLs are text only, never fetched',async t=>{
  const {store,requests}=await fixture(t),chat=await store.create();
  const attachments=[pic,{type:'link',url:'https://example.test/资料'}];
  await store.send(chat.id,request(40,{attachments}));await wait(()=>chat.status==='idle');
  let content=requests[0].body.messages.at(-1).content;
  assert.equal(content[1].type,'image_url');assert.equal(content[1].image_url.url,pic.dataUrl);assert.match(content[0].text,/网页内容尚未读取/);
  await store.send(chat.id,request(41,{providerId:'claude',attachments:[pic]}));await wait(()=>chat.status==='idle');
  content=requests[1].body.messages.at(-1).content;
  assert.equal(content[1].type,'image');assert.equal(content[1].source.media_type,'image/png');assert.equal(content[1].source.data,PNG);
  assert.equal(requests[1].body.messages[0].content[1].type,'image');
});

test('attachment validation rejects MIME spoofing, invalid base64, SVG and unsafe URLs',()=>{
  assert.equal(validateChatAttachments([pic])[0].bytes,Buffer.from(PNG,'base64').length);
  const invalid=[
    {...pic,mimeType:'image/jpeg'}, {...pic,dataUrl:'data:image/png;base64,AAAA'},
    {...pic,dataUrl:pic.dataUrl.replace('==','=')+'?'},
    {...pic,mimeType:'image/svg+xml',dataUrl:'data:image/svg+xml;base64,PHN2Zz4='},
    {type:'link',url:'file:///C:/secret.txt'}, {type:'link',url:'javascript:alert(1)'},
    {type:'link',url:'https://user:secret@example.com/'}, {type:'script',text:'invalid'},
  ];
  for(const input of invalid)assert.throws(()=>validateChatAttachments([input]));
  assert.throws(()=>validateChatAttachments(Array.from({length:5},()=>pic)),/4 张图片/);
  assert.throws(()=>validateChatAttachments(Array.from({length:9},()=>({type:'link',url:'https://example.test/'}))),/8 个链接/);
  assert.throws(()=>validateChatAttachments([{...pic,dataUrl:'x'.repeat(8*1024*1024)}]),error=>error.status===413);
});

test('restart marks an unfinished response interrupted and does not resend automatically',async t=>{
  const {engine,store,runtime,requests}=await fixture(t),chat=await store.create();
  const input=request(50),attachments=validateChatAttachments([]);
  chat.status='running';chat.messages.push({id:'user-one',role:'user',requestId:input.requestId,text:input.text,attachments,status:'completed'},{id:'reply-one',role:'assistant',requestId:input.requestId,status:'pending',text:'',attachments:[]});
  await store.persist();
  const restarted=await new ChatStore(engine).init();
  assert.equal(restarted.get(chat.id).status,'idle');assert.equal(restarted.get(chat.id).messages.at(-1).status,'interrupted');
  assert.match(restarted.get(chat.id).messages.at(-1).error,/可能已产生/);assert.equal(requests.length,0);
  assert.ok((await fs.readFile(path.join(runtime,'chats.json'),'utf8')).includes('interrupted'));
});

test('bounded context retains complete recent pairs, and failed turns are excluded',()=>{
  const messages=[];
  for(let i=0;i<15;i++){messages.push({role:'user',requestId:`pair-${i}`,text:`需求 ${i}`,attachments:[]},{role:'assistant',requestId:`pair-${i}`,status:'completed',text:`回复 ${i}`});}
  messages.push({role:'user',requestId:'failed',text:'失败的提问',attachments:[]},{role:'assistant',requestId:'failed',status:'failed',text:''});
  const current={role:'user',requestId:'current',text:'继续',attachments:[]};
  const result=chatModelMessages({messages},current,{type:'openai'});
  assert.equal(result.contextTruncated,true);assert.ok(result.messages.length<=CHAT_LIMITS.contextMessages+1);
  assert.equal(result.messages[1].role,'user');assert.equal(result.messages.at(-1).content,'继续');
  assert.ok(!JSON.stringify(result.messages).includes('失败的提问'));
});

test('chat and turn limits preserve saved history; deletion frees a slot',async t=>{
  const {store}=await fixture(t),chat=await store.create();
  chat.messages=Array.from({length:100},(_,i)=>({role:i%2?'assistant':'user',requestId:`old-${Math.floor(i/2)}`,text:'old',status:'completed',attachments:[]}));
  await assert.rejects(store.send(chat.id,request(60)),error=>error.code==='chat_limit');
  assert.equal(chat.messages.length,100);
  for(let i=1;i<CHAT_LIMITS.chats;i++)await store.create();
  await assert.rejects(store.create(),error=>error.code==='chat_limit');
  assert.deepEqual(await store.remove(chat.id),{deleted:true});await store.create();assert.equal(store.list().length,30);
});

test('stop aborts a pending reply, retains the conversation and allows another turn',async t=>{
  const {store,requests,controls}=await fixture(t),chat=await store.create();let release;
  controls.delay=new Promise(resolve=>{release=resolve;});
  await store.send(chat.id,request('stop'));await wait(()=>requests.length===1);
  const result=await store.stop(chat.id);assert.equal(result.stopped,true);assert.equal(chat.status,'idle');assert.equal(chat.messages.at(-1).status,'interrupted');assert.equal(chat.messages.at(-1).error,'你已停止这轮回复。');
  assert.equal((await store.stop(chat.id)).stopped,false);controls.delay=null;release();
  await store.send(chat.id,request('after-stop'));await wait(()=>chat.status==='idle');assert.equal(chat.messages.at(-1).status,'completed');assert.equal(chat.messages.length,4);assert.equal(requests.length,2);
});
