const failure=(code,message,extra={})=>Object.assign(new Error(message),{code,retry:false,...extra});
const token=value=>Number.isSafeInteger(value)&&value>=0?value:null;

// Read provider text deltas. Reasoning/thinking blocks are never public output.
export async function readModelStream(response,{anthropic=false,onText,redact=value=>value,limit=32*1024*1024,maxText=1024*1024,maxEvent=1024*1024}={}) {
  if(!response.body)throw failure('model_empty_response','模型没有返回响应内容。');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',text='',reasoning=false,finishReason='',completed=false,bytes=0,frames=0,reasoningChars=0,lastEmit=0,lastText='',input=null,output=null;
  const transport=()=>({bytes,frames,finalTextChars:text.length,ignoredReasoningChars:reasoningChars});
  const emit=async final=>{if(!onText)return;const value=redact(text,final);if(value===lastText)return;if(!final&&Date.now()-lastEmit<100)return;lastEmit=Date.now();lastText=value;await onText(value);};
  const usage=value=>{if(value){input=token(value.prompt_tokens??value.input_tokens)??input;output=token(value.completion_tokens??value.output_tokens)??output;}};
  const event=async frame=>{
    const lines=frame.split('\n'),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data)return;if(data==='[DONE]'){if(!anthropic)completed=true;return;}
    frames++;if(frames>100000)throw failure('model_response_too_large','模型接口发送了过多事件，已停止接收；已收到的正文保留。');
    let value;try{value=JSON.parse(data);}catch{throw failure('model_invalid_response','模型的流式响应格式损坏；已返回的文字保留，本次不会自动重发。');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw failure('model_invalid_response','模型返回了无效的流式事件，本次不会自动重发。');
    if(value.error||value.type==='error'){const detail=value.error||value,kind=String(detail.type||detail.code||'');throw failure(/overload/i.test(kind)?'model_overloaded':'model_stream_interrupted','模型在生成过程中返回错误；已返回的文字保留，请稍后决定是否重试。',{providerCode:kind.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,100),usage:{input,output}});}
    if(anthropic){
      if(value.type==='message_start')usage(value.message?.usage);
      if(value.type==='content_block_start'){if(value.content_block?.type==='text'&&typeof value.content_block.text==='string')text+=value.content_block.text;if(value.content_block?.type==='thinking')reasoning=true;}
      if(value.type==='content_block_delta'){if(value.delta?.type==='text_delta'&&typeof value.delta.text==='string')text+=value.delta.text;if(value.delta?.type==='thinking_delta'){reasoning=true;reasoningChars+=typeof value.delta.thinking==='string'?value.delta.thinking.length:0;}}
      if(value.type==='message_delta'){usage(value.usage);finishReason=value.delta?.stop_reason||finishReason;}
      if(value.type==='message_stop')completed=true;
    }else{
      const choice=value.choices?.find(item=>item.index===0)||value.choices?.[0],delta=choice?.delta;
      if(typeof delta?.content==='string')text+=delta.content;
      if(Array.isArray(delta?.content))text+=delta.content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('');
      if(delta?.reasoning_content||delta?.reasoning){reasoning=true;const value=delta.reasoning_content||delta.reasoning;if(typeof value==='string')reasoningChars+=value.length;}
      if(choice?.finish_reason)finishReason=String(choice.finish_reason);
      usage(value.usage);
    }
    if(text.length>maxText)throw failure('model_answer_too_large','模型生成的最终正文超过大小上限，已保留先前内容；请分段继续。');
    await emit(false);
  };
  try{
    while(!completed){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>limit)throw failure('model_response_too_large','模型接口的流量超过保护上限，已停止接收；这不代表你的任务内容过大。');buffer+=decoder.decode(item.value,{stream:true}).replace(/\r\n/g,'\n');buffer=buffer.replace(/\r\n/g,'\n');let split;while((split=buffer.indexOf('\n\n'))>=0){if(split>maxEvent)throw failure('model_response_too_large','模型接口单个事件过大，已停止接收。');const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);await event(frame);if(completed)break;}if(buffer.length>maxEvent)throw failure('model_response_too_large','模型接口单个事件过大，已停止接收。');}
    if(!completed){buffer+=decoder.decode();if(buffer.trim())await event(buffer);}
    if(!completed)throw failure('model_stream_interrupted','流式连接提前断开，结果尚未完成；已返回的文字保留，本次不会自动重发。',{usage:{input,output}});
    await emit(true);
    return anthropic?{content:[...(text?[{type:'text',text}]:[]),...(reasoning?[{type:'thinking',thinking:'present'}]:[])],stop_reason:finishReason,usage:{input_tokens:input,output_tokens:output},transport:transport()}:{choices:[{message:{content:text,...(reasoning?{reasoning_content:'present'}:{})},finish_reason:finishReason}],usage:{prompt_tokens:input,completion_tokens:output},transport:transport()};
  }catch(error){error.transport=transport();error.usage||={input,output};throw error;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
