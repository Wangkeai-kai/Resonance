import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../lib/models.mjs';
import {deepSeekThinking} from '../lib/model-policy.mjs';
import {isConversationQuestion} from '../lib/request-intent.mjs';

test('modern official DeepSeek requests explicitly disable default high thinking; opt-in remains available',async t=>{
  const requests=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{message:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}});});
  const provider={id:'deepseek',name:'DS',type:'openai',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},gateway=new ModelGateway({config:{providers:[provider]}},new Map([['deepseek','fixture-secret']]),async()=>{});
  assert.equal((await gateway.request(provider,[{role:'user',content:'Reply OK'}],128)).text,'OK');assert.deepEqual(requests[0].thinking,{type:'disabled'});
  await gateway.request({...provider,thinkingMode:'enabled'},[{role:'user',content:'Reply OK'}],128);assert.deepEqual(requests[1].thinking,{type:'enabled'});
  assert.equal(deepSeekThinking({...provider,model:'deepseek-reasoner'}),null);assert.equal(deepSeekThinking({...provider,baseUrl:'https://api.deepseek.com.example.com'}),null);
});

test('questions about models do not become document workflows while explicit deliverables remain tasks',()=>{
  for(const input of ['为什么没有调用kimi','请只用两句话说明：当前为什么没有调用 Kimi？依据应用给你的实际分工回答。','你管控几个模型','如何连接模型？','你好','123'])assert.equal(isConversationQuestion(input),true,input);
  for(const input of ['做一份八页的ppt产品展示','写一份为什么没有调用kimi的排查报告','帮我开发登录功能'])assert.equal(isConversationQuestion(input),false,input);
});
