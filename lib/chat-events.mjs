import {randomUUID} from 'node:crypto';

export function publicMessage(chatId, message) {
  const {fingerprint, versions, ...view} = message;
  const index=versions?.findIndex(item=>item.id===message.versionId)??-1;
  return {...view,versionCount:versions?.length?(versions.length+Number(index<0)):1,versionIndex:index<0?(versions?.length||0):index, attachments:(message.attachments || []).map((attachment,index) => {
    if (attachment.type !== 'image') return {...attachment};
    const {dataUrl, ...metadata} = attachment;
    return {...metadata, url:`/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(message.id)}/${index}`};
  })};
}

// The transport holds only the chats currently being watched. Reconnection uses
// a fresh authoritative snapshot, so process restarts need no unbounded replay log.
export class ChatEvents {
  constructor() { this.epoch=randomUUID(); this.topics=new Map(); this.connections=0; }
  version(chatId) { const topic=this.topics.get(chatId);return {epoch:topic?.epoch||this.epoch,seq:topic?.seq || 0}; }
  view(chat) {
    return {...chat, messages:chat.messages.map(message=>publicMessage(chat.id,message)), streamVersion:this.version(chat.id)};
  }
  subscribe(chat, listener) {
    let topic=this.topics.get(chat.id);
    if (this.connections>=64 || topic?.listeners.size>=8) throw Object.assign(new Error('会话实时连接较多，请关闭其他窗口后重试。'),{status:429});
    if (!topic) {
      topic={epoch:randomUUID(),seq:0,listeners:new Set(),messages:new Map(),meta:''};
      this.topics.set(chat.id,topic);
    }
    topic.listeners.add(listener);this.connections++;
    this.seed(chat,topic);
    try{listener('snapshot',{chat:this.view(chat),...this.version(chat.id)});}catch(error){topic.listeners.delete(listener);this.connections--;if(!topic.listeners.size)this.topics.delete(chat.id);throw error;}
    let closed=false;
    return ()=>{if(closed)return;closed=true;if(topic.listeners.delete(listener))this.connections--;if(!topic.listeners.size)this.topics.delete(chat.id);};
  }
  seed(chat,topic) {
    const {messages,...meta}=chat;
    topic.meta=JSON.stringify(meta);
    for(const message of messages)topic.messages.set(message.id,JSON.stringify(publicMessage(chat.id,message)));
  }
  publish(chat, changedIds) {
    const topic=this.topics.get(chat.id);if(!topic)return;
    const {messages,...meta}=chat,serializedMeta=JSON.stringify(meta),changed=[];
    const candidates=changedIds?messages.filter(message=>changedIds.includes(message.id)):messages;
    for(const message of candidates){
      const view=publicMessage(chat.id,message),value=JSON.stringify(view);
      const previous=topic.messages.get(message.id);
      if(previous!==value){
        topic.messages.set(message.id,value);
        const before=previous?JSON.parse(previous):null;
        if(before&&typeof view.text==='string'&&view.text.startsWith(before.text||'')){
          const update={...view,textDelta:view.text.slice((before.text||'').length)};delete update.text;changed.push(update);
        }else changed.push(view);
      }
    }
    const ids=new Set(messages.map(message=>message.id)),removed=[];
    for(const id of topic.messages.keys())if(!ids.has(id)){topic.messages.delete(id);removed.push(id);}
    if(!changed.length&&!removed.length&&serializedMeta===topic.meta)return;
    topic.meta=serializedMeta;topic.seq++;
    const data={id:chat.id,epoch:topic.epoch,seq:topic.seq,meta,messages:changed,removed,order:messages.map(message=>message.id)};
    for(const listener of [...topic.listeners]){try{listener('patch',data);}catch{if(topic.listeners.delete(listener))this.connections--;}}
    if(!topic.listeners.size)this.topics.delete(chat.id);
  }
  removed(chatId) {
    const topic=this.topics.get(chatId);if(!topic)return;
    for(const listener of [...topic.listeners])listener('deleted',{id:chatId});
  }
}

export function serveChatStream(request,response,store,chatId) {
  const chat=store.get(chatId);
  let unsubscribe,heartbeat,closed=false;
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe?.();};
  const listener=(event,data)=>{
    if(closed)return;
    if(response.writableLength>1024*1024){response.end();cleanup();return;}
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if(event==='deleted'){response.end();cleanup();}
  };
  response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  response.flushHeaders?.();
  response.on('close',cleanup);response.on('error',cleanup);
  try{unsubscribe=store.events.subscribe(chat,listener);}catch(error){listener('unavailable',{message:error.message});response.end();cleanup();return;}
  if(closed){unsubscribe();return;}
  heartbeat=setInterval(()=>{if(!closed)response.write(': heartbeat\n\n');},15000);heartbeat.unref?.();
}
