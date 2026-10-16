(() => {
  'use strict';
  async function consume(body,onEvent,signal) {
    const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
    try {
      while(!signal.aborted){
        const {value,done}=await reader.read();if(done)throw new Error('实时连接已结束');
        buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
        if(buffer.length>8*1024*1024)throw new Error('实时事件超过读取上限');
        let end;
        while((end=buffer.indexOf('\n\n'))>=0){
          const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
          const lines=frame.split('\n'),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
          if(!data)continue;
          const event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim()||'message';
          onEvent(event,JSON.parse(data));
        }
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  function watch(id,{onEvent,onState,onFallback}) {
    const controller=new AbortController();let timer,attempt=0;
    const run=async()=>{
      try {
        onState?.(attempt?'reconnecting':'connecting');
        const response=await fetch(`/api/chats/${encodeURIComponent(id)}/stream`,{headers:{Accept:'text/event-stream'},cache:'no-store',signal:controller.signal});
        if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')){
          await response.body?.cancel();if(response.status===404||response.ok){onState?.('fallback');onFallback?.();return;}
          throw new Error('实时连接暂不可用');
        }
        onState?.('connected');attempt=0;
        await consume(response.body,(event,data)=>{if(!controller.signal.aborted)onEvent(event,data);},controller.signal);
      }catch(error){
        if(controller.signal.aborted)return;
        onState?.('reconnecting');attempt++;
        timer=setTimeout(run,Math.min(1000*2**Math.min(attempt-1,4),15000));
      }
    };
    run();return {close(){controller.abort();clearTimeout(timer);}};
  }
  window.ChatStream=Object.freeze({watch,consume});
})();
