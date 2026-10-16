import {HttpError} from './safety.mjs';

export function planInput(messages) {
  if(!Array.isArray(messages)||messages.some(m=>!m||!['system','developer','user','assistant'].includes(m.role)||(typeof m.content!=='string'&&!Array.isArray(m.content))))throw new HttpError(400,'ChatGPT 消息格式无效');
  const parts=(message)=>typeof message.content==='string'?message.content:message.content.map(block=>{
    if(block?.type==='text'&&typeof block.text==='string')return {type:message.role==='assistant'?'output_text':'input_text',text:block.text};
    if(block?.type==='image_url'&&message.role==='user'&&typeof block.image_url?.url==='string')return {type:'input_image',image_url:block.image_url.url,...(['auto','high','low'].includes(block.image_url.detail)?{detail:block.image_url.detail}:{})};
    throw new HttpError(400,'ChatGPT 订阅不支持这种附件');
  });
  return {
    instructions:messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>typeof m.content==='string'?m.content:m.content.map(b=>{if(b?.type!=='text'||typeof b.text!=='string')throw new HttpError(400,'ChatGPT 指令必须为文本');return b.text;}).join('\n')).join('\n'),
    input:messages.filter(m=>!['system','developer'].includes(m.role)).map(m=>({role:m.role,content:parts(m)})),store:false,stream:true,
  };
}
export async function planRequest(connection,provider,messages,{signal,fetch:fetcher=fetch,onText}={}) {
  if(provider.baseUrl!=='https://api.openai.com/v1')throw new HttpError(400,'ChatGPT 授权只能用于官方 API 地址');
  if(signal?.aborted)throw new Error('任务已暂停');
  const input=planInput(messages);
  const token=await connection.accessToken(provider.accountId);
  const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);
  const response=await fetcher('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model:provider.model,...input}),signal:abort,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw new HttpError(response.status,`ChatGPT 请求未完成（HTTP ${response.status}）。${response.status===401?'请重新登录账号。':response.status===429?'可能达到账号用量限制，请在 ChatGPT 设置中查看。':'请检查模型权限或稍后重试。'}`);}
  if(!response.body)throw new Error('ChatGPT 未返回响应流');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',text='',done=false,usage={input:null,output:null},bytes=0;
  let lastEmit=0,lastText='';const emit=async final=>{if(typeof onText!=='function')return;let safe=connection.redact(text);if(!final)for(let size=Math.min(token.length-1,safe.length);size>0;size--)if(safe.endsWith(token.slice(0,size))){safe=safe.slice(0,-size);break;}if(safe===lastText||!final&&Date.now()-lastEmit<100)return;lastEmit=Date.now();lastText=safe;await onText(safe);};
  const consume=raw=>{
    const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data||data==='[DONE]')return;
    let event;try{event=JSON.parse(data);}catch{throw new Error('ChatGPT 返回了无法解析的响应流，请重试。');}
    if(!event||typeof event!=='object')throw new Error('ChatGPT 响应事件无效，请重试。');
    if(event.type==='response.output_text.delta'){if(typeof event.delta!=='string')throw new Error('ChatGPT 回复内容格式无效，请重试。');text+=event.delta;}
    if(event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete')throw new Error('ChatGPT 未完整完成本轮回复，请稍后重试；本轮可能已产生用量。');
    if(event.type==='response.completed'){
      if(!event.response||typeof event.response!=='object'||(event.response.status&&event.response.status!=='completed'))throw new Error('ChatGPT 未返回有效的完成状态，请重试。');
      done=true;usage={input:event.response?.usage?.input_tokens??null,output:event.response?.usage?.output_tokens??null};
      if(!text)text=(event.response?.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
    }
    if(text.length>200000)throw new Error('回复过长，已停止接收，请缩小问题范围');
  };
  try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>4000000)throw new Error('响应流过大，已停止接收');buffer=(buffer+decoder.decode(item.value,{stream:true})).replace(/\r\n/g,'\n');let at;while((at=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,at));buffer=buffer.slice(at+2);}await emit(false);if(done)break;}if(buffer.trim()&&!done)consume(buffer);}
  finally{await reader.cancel().catch(()=>{});}
  if(!done||!text.trim())throw new Error('ChatGPT 连接中断，未收到完整回复。记录已保留，可以手动重试。');
  await emit(true);
  return {text:connection.redact(text),usage,provider:provider.id,model:provider.model};
}
