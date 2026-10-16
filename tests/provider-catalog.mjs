import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Engine} from '../lib/engine.mjs';
import {PRESETS,chooseModel,discoverModels,isChatModel} from '../lib/providers.mjs';

test('service presets do not freeze new connections to old model versions',()=>{
  assert.equal(PRESETS.length,11);
  assert.ok(PRESETS.some(preset=>preset.id==='deepseek'));
  assert.ok(PRESETS.every(preset=>preset.model===''));
});

test('reasoning models stay selectable while non-chat products are excluded from auto-selection',()=>{
  for(const id of ['deepseek-reasoner','deepseek-r1','kimi-thinking','o3','o4-mini'])assert.equal(isChatModel(id),true,id);
  for(const id of ['text-embedding-3','rerank-test','whisper-1','tts-1','image-generation'])assert.equal(isChatModel(id),false,id);
  assert.equal(chooseModel([{id:'text-embedding-3'},{id:'deepseek-reasoner'}]),'deepseek-reasoner');
  assert.equal(chooseModel([{id:'deepseek-reasoner'},{id:'local-chat'}]),'local-chat');
  assert.equal(chooseModel([{id:'local-chat'},{id:'deepseek-reasoner'}],'deepseek-reasoner'),'deepseek-reasoner');
});

test('automatic selection respects provider order instead of hardcoded old family preferences',()=>{
  assert.equal(chooseModel([{id:'fixture-new-version'},{id:'gpt-4.1-mini'}]),'fixture-new-version');
  assert.equal(chooseModel([{id:'fixture-kimi-next'},{id:'moonshot-v1-8k'}]),'fixture-kimi-next');
  assert.equal(chooseModel([{id:'fixture-new-version'},{id:'gpt-4.1-mini'}],'gpt-4.1-mini'),'gpt-4.1-mini');
});

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-catalog-'));
  const requests=[];
  let models=[{id:'text-embedding-test'},{id:'fixture-new-version',name:'New account model'},{id:'gpt-4.1-mini'},{id:'deepseek-reasoner'},{id:'kimi-thinking'}];
  let listStatus=200;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=raw?JSON.parse(raw):null;
    requests.push({url:req.url,body,authorization:req.headers.authorization});
    res.setHeader('Content-Type','application/json');
    if(req.url.endsWith('/models')){res.statusCode=listStatus;res.end(JSON.stringify({data:models}));return;}
    res.end(JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const engine=new Engine(root);
  await fs.mkdir(engine.runtime,{recursive:true});
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gongming-catalog-'));
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  return {engine,baseUrl,requests,setModels:value=>{models=value;},setStatus:value=>{listStatus=value;}};
}

test('account discovery keeps DeepSeek and Kimi reasoning IDs without inventing catalog entries',async t=>{
  const {baseUrl}=await fixture(t);
  const models=await discoverModels({baseUrl,type:'openai'},'fixture-key');
  assert.ok(models.some(model=>model.id==='deepseek-reasoner'));
  assert.ok(models.some(model=>model.id==='kimi-thinking'));
  assert.ok(!models.some(model=>model.id==='kimi-3.0'));
  assert.equal(models.find(model=>model.id==='fixture-new-version').name,'New account model');
});

test('new connection uses actual discovery; explicit reconnection keeps the selected version',async t=>{
  const {engine,baseUrl,requests}=await fixture(t);
  const connected=await engine.connect({presetId:'openai',baseUrl,apiKey:'fixture-key'});
  assert.equal(connected.provider.model,'fixture-new-version');
  assert.equal(requests[0].url,'/v1/models');
  assert.equal(requests[1].body.model,'fixture-new-version');
  requests.length=0;
  await engine.connect({presetId:'openai',baseUrl,model:'gpt-4.1-mini'});
  assert.equal(requests.length,1);
  assert.equal(requests[0].body.model,'gpt-4.1-mini');
  assert.equal(requests[0].authorization,'Bearer fixture-key');
});

test('discovery failure never falls back to a stale model or alters existing credentials and routing',async t=>{
  const {engine,baseUrl,requests,setStatus}=await fixture(t);
  await engine.connect({presetId:'moonshot',baseUrl,model:'fixture-current',apiKey:'fixture-original-key'});
  const before=JSON.stringify(engine.state.config);
  const beforeDisk=await fs.readFile(path.join(engine.runtime,'state.json'),'utf8');
  requests.length=0;setStatus(404);
  await assert.rejects(()=>engine.connect({presetId:'moonshot',baseUrl,apiKey:'fixture-replacement-key'}),/模型列表/);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/v1/models');
  assert.equal(JSON.stringify(engine.state.config),before);
  assert.equal(engine.keys.get('moonshot'),'fixture-original-key');
  assert.equal(await fs.readFile(path.join(engine.runtime,'state.json'),'utf8'),beforeDisk);
});

test('reasoning-only discovery can connect and non-chat-only discovery does not send a completion',async t=>{
  const {engine,baseUrl,requests,setModels}=await fixture(t);
  setModels([{id:'deepseek-reasoner'}]);
  const connected=await engine.connect({presetId:'deepseek',baseUrl});
  assert.equal(connected.provider.model,'deepseek-reasoner');
  requests.length=0;setModels([{id:'text-embedding-test'}]);
  await assert.rejects(()=>engine.connect({presetId:'deepseek',baseUrl}),/文本模型/);
  assert.equal(requests.length,1);
  assert.equal(engine.state.config.providers[0].model,'deepseek-reasoner');
});
