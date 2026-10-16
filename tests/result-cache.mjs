import test from 'node:test';
import assert from 'node:assert/strict';
import {ResultCache} from '../lib/result-cache.mjs';
import {ModelGateway} from '../lib/models.mjs';

test('LRU retains recently used results and evicts old entries', () => {
  const cache=new ResultCache({maxEntries:2});
  cache.set('old',{value:1});cache.set('used',{value:2});cache.get('old');cache.set('new',{value:3});
  assert.equal(cache.size,2);assert.equal(cache.get('used'),undefined);assert.deepEqual(cache.get('old'),{value:1});
});
test('cache is bounded by UTF-8 bytes and oversized results are not retained', () => {
  const cache=new ResultCache({maxBytes:100});
  for(let i=0;i<100;i++)cache.set('result-'+i,{text:'中文'.repeat(6)});
  assert.ok(cache.bytes<=100);assert.ok(cache.size<=2);
  assert.equal(cache.set('oversize',{text:'中'.repeat(100)}),false);assert.ok(cache.bytes<=100);
  cache.clear();assert.equal(cache.size,0);assert.equal(cache.bytes,0);
});
test('results expire without refreshing their lifetime on a cache hit', () => {
  let now=0;const cache=new ResultCache({ttlMs:100,clock:()=>now});cache.set('result',{ok:true});
  now=90;assert.equal(cache.get('result').ok,true);now=100;assert.equal(cache.get('result'),undefined);assert.equal(cache.bytes,0);
  cache.set('second',{ok:true});now=201;assert.equal(cache.size,0);
});
test('mutations by either a producer or consumer cannot contaminate cached data', () => {
  const cache=new ResultCache(),source={files:[{content:'original'}]};cache.set('r',source);source.files[0].content='producer changed';
  const first=cache.get('r');assert.equal(first.files[0].content,'original');first.files[0].content='consumer changed';assert.equal(cache.get('r').files[0].content,'original');
});
test('model completion reuses detached cached results without spending tokens twice', async () => {
  let requests=0;const events=[];
  const gateway=new ModelGateway({config:{providers:[{id:'local',name:'Local',type:'openai',baseUrl:'http://127.0.0.1:11434/v1',model:'fixture'}],agentProviders:{}}},new Map(),async(...args)=>events.push(args));
  gateway.request=async()=>{requests++;return {text:'{"items":["original"]}',usage:{input:2,output:3}};};
  const job={id:'job',budget:10000,tokens:{reserved:0,input:0,output:0}};
  const first=await gateway.complete(job,'docs','Read',{});first.items.push('changed');const reserved=job.tokens.reserved;
  const second=await gateway.complete(job,'docs','Read',{});assert.deepEqual(second,{items:['original']});assert.equal(requests,1);assert.equal(job.tokens.reserved,reserved);assert.equal(job.tokens.input,2);assert.ok(events.some(event=>event[2]==='model_cache_hit'));
});
