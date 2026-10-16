import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../dist/voice.js',import.meta.url),'utf8');
function fixture({desktop=false}={}) {
  const listeners=new Map(),nodes=new Map(),instances=[];
  const element=selector=>({value:'',disabled:false,attributes:{},events:[],closest(selectors){return selectors.split(',').some(value=>value.trim()===selector)?this:null;},setAttribute(key,value){this.attributes[key]=value;},focus(){},setSelectionRange(){},dispatchEvent(event){this.events.push(event);},before(node){nodes.set('#'+node.id,node);}});
  const input=element('#chatText'),voice=element('#chatVoice'),form=element('#chatForm');
  nodes.set('#chatText',input);nodes.set('#chatVoice',voice);nodes.set('#chatForm',form);
  const document={querySelector:selector=>nodes.get(selector),getElementById:id=>nodes.get('#'+id),createElement:()=>element(''),addEventListener(type,listener,capture=false){const entries=listeners.get(type)||[];entries.push({listener,capture});listeners.set(type,entries);}};
  class Speech {
    constructor(){instances.push(this);this.aborts=0;this.stops=0;}
    start(){this.onstart?.();}
    stop(){this.stops++;}
    abort(){this.aborts++;this.onend?.();}
    result(text,isFinal=true){const result=[{transcript:text}];result.isFinal=isFinal;this.onresult({resultIndex:0,results:[result]});}
  }
  const dispatch=(type,selector='',extra={})=>{const event={target:nodes.get(selector)||element(selector),...extra};for(const {listener} of [...(listeners.get(type)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))listener(event);};
  vm.runInNewContext(source,{document,window:{SpeechRecognition:Speech,...(desktop?{gongmingDesktop:{platform:'win32'}}:{})},navigator:{platform:desktop?'Win32':'Linux'},Event});
  return {input,voice,instances,nodes,element,dispatch,start(){dispatch('click','#chatVoice');return instances.at(-1);},note:()=>nodes.get('#voiceNote')?.textContent};
}

test('browser dictation updates only the draft and manual stop can keep its final result',()=>{
  const f=fixture();f.input.value='本轮草稿';const speech=f.start();
  speech.result('语音内容',false);assert.equal(f.input.value,'本轮草稿\n语音内容');
  assert.ok(f.input.events.every(event=>event.type==='input'));
  f.dispatch('click','#chatVoice');assert.equal(speech.stops,1);
  speech.result('最终文字');speech.onend();assert.equal(f.input.value,'本轮草稿\n最终文字');assert.equal(f.voice.attributes['aria-pressed'],'false');
});

test('contact, history, team and view navigation discard queued results from the previous chat',()=>{
  for(const selector of ['[data-direct-provider]','[data-chat-id]','#chatCreateTeam','#chatNew','[data-view]','#chatTransfer','#chatDelete','[data-chat-task]','[data-chat-prompt]']) {
    const f=fixture();f.input.value='A 的私密草稿';const previous=f.start();
    f.dispatch('click',selector);f.input.value='B 的草稿';previous.result('迟到结果');
    assert.equal(f.input.value,'B 的草稿',selector);assert.equal(previous.aborts,1,selector);
    const current=f.start(),note=f.note();previous.onstart();previous.onerror({error:'network'});previous.onend();
    assert.equal(f.voice.attributes['aria-pressed'],'true',selector);assert.equal(f.note(),note,selector);
    current.result('新会话语音');assert.equal(f.input.value,'B 的草稿\n新会话语音',selector);
  }
});

test('programmatic navigation and every send entry point invalidate browser recognition',()=>{
  for(const [type,selector,extra] of [['gongming:chat-context-changing','',{}],['submit','#chatForm',{}],['click','#chatSend',{}],['keydown','#chatText',{key:'Enter',shiftKey:false,isComposing:false}]]) {
    const f=fixture();const previous=f.start();f.dispatch(type,selector,extra);f.input.value='下一轮';previous.result('旧结果');assert.equal(f.input.value,'下一轮');assert.equal(previous.aborts,1);
  }
  for(const extra of [{key:'Enter',shiftKey:true,isComposing:false},{key:'Enter',shiftKey:false,isComposing:true}]) {
    const f=fixture(),speech=f.start();f.dispatch('keydown','#chatText',extra);speech.result('继续输入');assert.equal(f.input.value,'继续输入');assert.equal(speech.aborts,0);
  }
});

test('disabled or replaced inputs never accept a late browser transcription',()=>{
  const f=fixture();f.input.disabled=true;f.start();assert.equal(f.instances.length,0);
  f.input.disabled=false;const previous=f.start();f.input.disabled=true;previous.result('不能写入');assert.equal(f.input.value,'');assert.equal(previous.aborts,1);
  f.input.disabled=false;previous.result('重新启用后仍迟到');assert.equal(f.input.value,'');
  const second=f.start(),replacement=f.element('#chatText');replacement.value='新输入框';f.nodes.set('#chatText',replacement);second.result('旧输入框');assert.equal(replacement.value,'新输入框');assert.equal(f.input.value,'');assert.equal(second.aborts,1);
});

test('Windows desktop continues to use system dictation without starting browser recognition',()=>{
  const f=fixture({desktop:true});f.start();assert.equal(f.instances.length,0);assert.match(f.note(),/Windows 语音输入/);
  f.dispatch('gongming:dictation','',{detail:{ok:true}});assert.match(f.note(),/已请求 Windows 语音输入/);
  f.dispatch('gongming:chat-context-changing');assert.equal(f.instances.length,0);
});
