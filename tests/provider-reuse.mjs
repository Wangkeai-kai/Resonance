import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectionCandidate} from '../lib/providers.mjs';
import {Engine} from '../lib/engine.mjs';
import {ModelGateway} from '../lib/models.mjs';

const source={id:'source-one',name:'GPT',type:'openai',baseUrl:'https://api.openai.com/v1',model:'fixture-v1'};
const second={...source,id:'source-two',model:'fixture-v2'};
const providers=[source,second];
const keys=new Map([['source-one','fixture-first-secret'],['source-two','fixture-second-secret']]);
const input={presetId:'openai',connectionId:'new-version',sourceConnectionId:'source-one',model:'fixture-v3'};

test('new model version reuses the selected source credential, never target id',()=>{
  const result=connectionCandidate(input,providers,keys);
  assert.equal(result.provider.id,'new-version');assert.equal(result.provider.model,'fixture-v3');assert.equal(result.apiKey,'fixture-first-secret');
  assert.equal(connectionCandidate({...input,connectionId:'source-two'},providers,keys).apiKey,'fixture-first-secret');
  assert.equal(keys.size,2);assert.equal(providers.length,2);
});
test('omitted key allows reuse; explicit empty key does not silently reuse',()=>{
  assert.throws(()=>connectionCandidate({...input,apiKey:''},providers,keys),/API Key/);
  assert.equal(connectionCandidate({...input,apiKey:'replacement'},providers,keys).apiKey,'replacement');
});
test('endpoint and protocol changes never inherit credentials',()=>{
  for(const baseUrl of ['https://example.invalid/v1','https://api.openai.com/other'])assert.throws(()=>connectionCandidate({...input,baseUrl},providers,keys),/API Key/);
  assert.throws(()=>connectionCandidate({...input,presetId:'anthropic',baseUrl:source.baseUrl},providers,keys),/API Key/);
  assert.equal(connectionCandidate({...input,baseUrl:'http://127.0.0.1:11434/v1'},providers,keys).apiKey,'');
  assert.equal(connectionCandidate({...input,baseUrl:source.baseUrl+'/'},providers,keys).apiKey,'fixture-first-secret');
});
test('invalid or missing source is rejected instead of falling back to a target key',()=>{
  for(const sourceConnectionId of ['',null,3,'../source','x'.repeat(65),'missing-source'])assert.throws(()=>connectionCandidate({...input,connectionId:'source-two',sourceConnectionId},providers,keys),e=>e.status===400);
});
test('restarting with no memory key requires cloud authentication again',()=>{
  assert.throws(()=>connectionCandidate(input,providers,new Map()),/API Key/);
  assert.equal(connectionCandidate({presetId:'openai',connectionId:'source-two',model:'fixture-v4'},providers,keys).apiKey,'fixture-second-secret');
});
test('model-list candidate also supports selected source without explicit model',()=>{
  const {model,...lookup}=input;const result=connectionCandidate(lookup,providers,keys);
  assert.equal(result.explicitModel,false);assert.equal(result.apiKey,'fixture-first-secret');
  assert.ok(!JSON.stringify(result.provider).includes('secret'));
});
test('adding an API version preserves an authorized ChatGPT role and repairs disconnected mappings',async()=>{
  const engine=new Engine('.');let signedIn=true;
  engine.state.config={providers:[{id:'plan-connection',type:'chatgpt-plan',accountId:'account-one',baseUrl:'https://chatgpt.com/backend-api',model:'fixture-plan'}],agentProviders:{orchestrator:'plan-connection'}};
  engine.gateway.chatgpt={connected:id=>id==='account-one'&&signedIn,status:()=>({accounts:[{id:'account-one',planEnabled:true}]})};
  engine.record=async()=>{};engine.applyConfig=async input=>{engine.state.config=input;return input;};
  const originalTest=ModelGateway.prototype.test;
  ModelGateway.prototype.test=async providerId=>({ok:true,provider:providerId,message:'mock'});
  try{
    await engine.connect({presetId:'openai',connectionId:'cloud-one',model:'fixture-chat',apiKey:'fixture-key'});
    assert.equal(engine.state.config.agentProviders.orchestrator,'plan-connection');
    signedIn=false;
    await engine.connect({presetId:'openai',connectionId:'cloud-two',model:'fixture-chat-2',apiKey:'fixture-key-2'});
    assert.equal(engine.state.config.agentProviders.orchestrator,'cloud-two');
  }finally{ModelGateway.prototype.test=originalTest;}
});
