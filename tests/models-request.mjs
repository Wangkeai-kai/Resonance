import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {ModelGateway} from '../lib/models.mjs';

const messages=[{role:'user',content:'Fixture request'}];
const result=(content='OK',extra={})=>({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3},...extra});
function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(data));}
async function fixture(t,handler){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;requests.push(body);
    try{await handler(req,res,body,requests.length);}catch(error){res.destroy(error);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const provider={id:'fixture',name:'Fixture',type:'openai',model:'fixture-model',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  const gateway=new ModelGateway({config:{providers:[provider],agentProviders:{}}},new Map([['fixture','fixture-secret']]),async()=>{});
  return {requests,provider,gateway,request:options=>gateway.request(provider,messages,200,options)};
}

test('malformed successful JSON never triggers another billable request',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{invalid');});
  await assert.rejects(()=>f.request(),error=>error.code==='model_invalid_response'&&error.retry===false);
  assert.equal(f.requests.length,1);
});

test('task calls request JSON mode and malformed task content gives a recoverable message without a new call',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,200,result('{"items":["one" "two"]}'))),job={id:'task',budget:100000,tokens:{reserved:0,input:0,output:0}};
  await assert.rejects(f.gateway.complete(job,'context','Return {summary}.',{}),error=>error.code==='model_invalid_structured_response'&&/已完成步骤保留/.test(error.message));
  assert.deepEqual(f.requests[0].response_format,{type:'json_object'});assert.equal(f.requests.length,1);assert.equal(job.tokens.output,3);
});

test('only explicit JSON mode parameter rejection may remove that parameter and retry',async t=>{
  const f=await fixture(t,(_req,res,body,count)=>count===1?json(res,400,{error:{message:'Unsupported parameter response_format'}}):json(res,200,result('{"summary":"ok"}')));
  const job={id:'task',budget:100000,tokens:{reserved:0,input:0,output:0}};
  assert.equal((await f.gateway.complete(job,'architect','Return {summary}.',{})).summary,'ok');assert.equal(f.requests.length,2);assert.ok(f.requests[0].response_format);assert.ok(!f.requests[1].response_format);
});

test('timeout includes delayed headers and does not automatically resend',async t=>{
  const f=await fixture(t,()=>{});const started=Date.now();
  await assert.rejects(()=>f.request({timeoutMs:100}),error=>error.code==='model_timeout'&&error.status===504);
  assert.equal(f.requests.length,1);assert.ok(Date.now()-started<1500);
});

test('timeout includes a stalled response body, not just response headers',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":');});
  await assert.rejects(()=>f.request({timeoutMs:100}),error=>error.code==='model_timeout');
  assert.equal(f.requests.length,1);
});

test('cancelling an in-flight body closes the request without resending',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');setTimeout(()=>controller.abort(),20);});
  await assert.rejects(()=>f.request({signal:controller.signal}),error=>error.code==='model_cancelled');
  assert.equal(f.requests.length,1);
});

test('pre-cancelled requests never reach the provider',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,200,result()));
  await assert.rejects(()=>f.request({signal:AbortSignal.abort()}),error=>error.code==='model_cancelled');
  assert.equal(f.requests.length,0);
});

test('Kimi-style 429 overload remains distinct from quota and preserves retry information',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,429,{error:{type:'engine_overloaded_error',message:'The engine is currently overloaded, please try again later fixture-secret'}},{'retry-after':'30'}));
  await assert.rejects(()=>f.request({maxAttempts:1}),error=>error.code==='model_overloaded'&&error.status===429&&error.providerCode==='engine_overloaded_error'&&error.retryAfterSeconds===30&&!error.message.includes('fixture-secret'));
  assert.equal(f.requests.length,1);
});

test('quota errors and ambiguous server errors are not automatically retried',async t=>{
  for(const [status,payload,code] of [[429,{error:{code:'insufficient_quota',message:'quota exceeded'}},'model_quota_exceeded'],[500,{error:{message:'internal error'}},'model_http_error']]){
    const f=await fixture(t,(_req,res)=>json(res,status,payload));
    await assert.rejects(()=>f.request(),error=>error.code===code&&error.retry===false);
    assert.equal(f.requests.length,1);
  }
});

test('only explicit rate rejection is retried, respecting short Retry-After',async t=>{
  const f=await fixture(t,(_req,res,_body,count)=>count===1?json(res,429,{error:{type:'rate_limit_error'}},{'retry-after':'0'}):json(res,200,result()));
  assert.equal((await f.request()).text,'OK');assert.equal(f.requests.length,2);
});

test('long Retry-After returns promptly and cancellation interrupts retry delay',async t=>{
  const long=await fixture(t,(_req,res)=>json(res,429,{error:{type:'rate_limit_error'}},{'retry-after':'600'}));
  const start=Date.now();await assert.rejects(()=>long.request(),error=>error.retryAfterSeconds===600);
  assert.ok(Date.now()-start<500);assert.equal(long.requests.length,1);
  const controller=new AbortController();
  const stopped=await fixture(t,(_req,res)=>{json(res,429,{error:{type:'rate_limit_error'}});setTimeout(()=>controller.abort(),20);});
  await assert.rejects(()=>stopped.request({signal:controller.signal}),error=>error.code==='model_cancelled');
  assert.equal(stopped.requests.length,1);
});

test('legacy token parameter fallback requires the exact rejected parameter',async t=>{
  const legacy=await fixture(t,(_req,res,body,count)=>count===1?json(res,400,{error:{message:"Unknown field 'max_completion_tokens', use max_tokens"}}):json(res,200,result()));
  await legacy.request();assert.equal(legacy.requests.length,2);
  assert.equal(legacy.requests[0].max_completion_tokens,200);assert.equal(legacy.requests[1].max_tokens,200);
  assert.ok(!('max_completion_tokens' in legacy.requests[1]));assert.equal(legacy.requests[1].stream,false);
  const unrelated=await fixture(t,(_req,res)=>json(res,400,{error:{message:'Unsupported parameter: image_url'}}));
  await assert.rejects(()=>unrelated.request(),error=>error.status===400);
  assert.equal(unrelated.requests.length,1);
});

test('reasoning-only responses do not expose reasoning as final answers or trigger retries',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,200,result(null,{choices:[{message:{content:null,reasoning_content:'internal reasoning'},finish_reason:'stop'}]})));
  await assert.rejects(()=>f.request(),error=>error.code==='model_reasoning_only'&&error.usage.input===5&&error.usage.output===3&&!error.message.includes('internal reasoning'));
  assert.equal(f.requests.length,1);
});

test('output limits distinguish missing final answer from a usable partial answer',async t=>{
  const empty=await fixture(t,(_req,res)=>json(res,200,result(null,{choices:[{message:{content:'',reasoning_content:'hidden'},finish_reason:'length'}]})));
  await assert.rejects(()=>empty.request(),error=>error.code==='model_output_limit'&&error.finishReason==='length');
  const partial=await fixture(t,(_req,res)=>json(res,200,result('A partial final answer',{choices:[{message:{content:'A partial final answer'},finish_reason:'length'}]})));
  const value=await partial.request();assert.equal(value.text,'A partial final answer');assert.equal(value.truncated,true);assert.equal(value.finishReason,'length');
});

test('OpenAI text blocks and Anthropic text blocks return only final text',async t=>{
  const openai=await fixture(t,(_req,res)=>json(res,200,result([{type:'text',text:'Visible text'},{type:'thinking',text:'hidden'}])));
  assert.equal((await openai.request()).text,'Visible text');
  const claude=await fixture(t,(_req,res)=>json(res,200,{content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'Claude answer'}],stop_reason:'end_turn',usage:{input_tokens:7,output_tokens:8}}));
  claude.provider.type='anthropic';const answer=await claude.request();assert.equal(answer.text,'Claude answer');assert.deepEqual(answer.usage,{input:7,output:8});
});

test('oversized chunked responses stop while reading instead of accumulating the full body',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('x'.repeat(3000001));});
  await assert.rejects(()=>f.request(),error=>error.code==='model_response_too_large');
  assert.equal(f.requests.length,1);
});

test('unexpected SSE is rejected explicitly and never interpreted as JSON',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: pending\n\n');});
  await assert.rejects(()=>f.request(),error=>error.code==='model_invalid_response'&&/流式/.test(error.message));
  assert.equal(f.requests.length,1);
});

test('untrusted usage fields never become negative or string token totals',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,200,result('OK',{usage:{prompt_tokens:-3,completion_tokens:'999'}})));
  assert.deepEqual((await f.request()).usage,{input:null,output:null});
});

test('workflow rejects truncated artifacts and preserves usage from unsuccessful responses',async t=>{
  const truncated=await fixture(t,(_req,res)=>json(res,200,result('{"summary":"partial"}',{choices:[{message:{content:'{"summary":"partial"}'},finish_reason:'length'}]})));
  const job={id:'fixture-job',budget:10000,tokens:{reserved:0,input:0,output:0}};
  await assert.rejects(()=>truncated.gateway.complete(job,'orchestrator','Fixture',{}),error=>error.code==='model_output_limit');
  assert.equal(truncated.gateway.cache.size,0);assert.equal(job.tokens.input,5);assert.equal(job.tokens.output,3);
  const noAnswer=await fixture(t,(_req,res)=>json(res,200,result(null,{choices:[{message:{content:null,reasoning_content:'hidden'},finish_reason:'stop'}]})));
  await assert.rejects(()=>noAnswer.gateway.complete(job,'orchestrator','Fixture',{}),error=>error.code==='model_reasoning_only');
  assert.equal(job.tokens.input,10);assert.equal(job.tokens.output,6);
});
