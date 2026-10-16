import {id,now,HttpError} from './safety.mjs';
import {validateChatAttachments,CHAT_LIMITS} from './chat.mjs';

const terminalStatus=value=>['completed','failed','interrupted','skipped'].includes(value)?value:'interrupted';
function importReplyFields(source,target) {
  for(const name of ['providerId','providerName','model','purpose','error','errorCode','phase','finishReason','completedAt','sourceFingerprint'])if(typeof source[name]==='string')target[name]=source[name].slice(0,name==='error'?1000:160);
  for(const name of ['truncated','sourcesChanged'])if(typeof source[name]==='boolean')target[name]=source[name];
  if(source.usage&&typeof source.usage==='object'){
    target.usage={};for(const name of ['input','output'])if(Number.isFinite(source.usage[name])&&source.usage[name]>=0)target.usage[name]=source.usage[name];
  }
}
function importVersions(source,target) {
  if(source.versions===undefined)return;
  if(!Array.isArray(source.versions)||source.versions.length>20)throw new HttpError(400,'回复版本数量无效，每条最多导入 20 个版本。');
  const ids=new Map();target.versions=source.versions.map(version=>{
    if(!version||typeof version.id!=='string'||ids.has(version.id)||typeof version.text!=='string'||version.text.length>100000)throw new HttpError(400,'会话文件含无效回复版本。');
    const value={id:id('version'),text:version.text,status:terminalStatus(version.status)};ids.set(version.id,value.id);importReplyFields(version,value);return value;
  });
  if(typeof source.versionId==='string'&&ids.has(source.versionId))target.versionId=ids.get(source.versionId);
  else if(target.versions.length){
    if(target.versions.length>=20)throw new HttpError(400,'当前回复未包含在版本历史中，无法完整导入。');
    target.versionId=id('version');
  }
}

export async function archiveChat(store,chatId,archived) {
  const chat=store.get(chatId);
  if(store.active.has(chatId))throw new HttpError(409,'先停止当前回复，再归档会话。');
  if(!archived&&chat.archived&&store.chats.filter(item=>!item.archived).length>=CHAT_LIMITS.chats)throw new HttpError(409,'最近会话已满，请先归档其他会话。');
  const previous=chat.archived;chat.archived=archived===true;chat.updatedAt=now();
  try{await store.persist();}catch(error){chat.archived=previous;throw error;}
  return {chat};
}

export function exportChat(store,chatId) {
  const chat=store.get(chatId);
  return {format:'gongming-conversation',version:1,exportedAt:now(),chat:structuredClone(chat)};
}

export async function importChat(store,input) {
  if(input?.format!=='gongming-conversation'||input.version!==1||!input.chat||!Array.isArray(input.chat.messages))throw new HttpError(400,'这不是支持的共鸣会话文件。');
  if(input.chat.messages.length>1000)throw new HttpError(400,'导入文件消息过多，请分拆后导入。');
  const source=input.chat,requests=new Map(),messages=[];let bytes=0;
  for(const message of source.messages){
    if(!['user','assistant'].includes(message?.role)||typeof message.text!=='string'||message.text.length>100000)throw new HttpError(400,'会话文件含无效消息。');
    const attachments=validateChatAttachments(message.attachments||[]);bytes+=attachments.reduce((n,a)=>n+(a.bytes||0),0);
    if(bytes>CHAT_LIMITS.chatImageBytes)throw new HttpError(413,'导入图片合计超过 20 MB。');
    const original=String(message.requestId||message.id);if(!requests.has(original))requests.set(original,id('request'));
    const clean={id:id('message'),requestId:requests.get(original),role:message.role,text:message.text,attachments,status:message.role==='user'?'completed':terminalStatus(message.status),createdAt:now()};
    importReplyFields(message,clean);
    if(message.role==='assistant')importVersions(message,clean);
    if(Array.isArray(message.recipientIds))clean.recipientIds=message.recipientIds.filter(item=>typeof item==='string').slice(0,12);
    if(typeof message.summarize==='boolean')clean.summarize=message.summarize;
    messages.push(clean);
  }
  const kind=['direct','team'].includes(source.kind)?source.kind:'legacy';
  const chat={id:id('chat'),title:String(source.title||'导入的会话').slice(0,80),kind,directProviderId:typeof source.directProviderId==='string'?source.directProviderId.slice(0,100):'',participantIds:Array.isArray(source.participantIds)?source.participantIds.filter(item=>typeof item==='string').slice(0,12):[],leadProviderId:typeof source.leadProviderId==='string'?source.leadProviderId.slice(0,100):'',providerId:'',messages,status:'idle',archived:true,imported:true,jobIds:[],createdAt:now(),updatedAt:now()};
  store.chats.push(chat);try{await store.persist();}catch(error){store.chats.pop();throw error;}return {chat};
}

// Editing an earlier user turn creates an explicit branch, preserving all
// original messages. The subsequent send uses the ordinary idempotent pipeline.
export async function forkChat(store,chatId,input) {
  const source=store.get(chatId);
  if(store.active.has(chatId))throw new HttpError(409,'先停止当前回复，再编辑或分支会话。');
  if(typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId))throw new HttpError(400,'分支请求编号无效。');
  const existing=store.chats.find(chat=>chat.branchRequestId===input.requestId&&chat.branchOf===chatId);if(existing)return {chat:existing,reused:true};
  if(store.chats.filter(chat=>!chat.archived).length>=CHAT_LIMITS.chats)throw new HttpError(409,'最近会话已满，请先归档不常用的会话。');
  const index=input.messageId?source.messages.findIndex(message=>message.id===input.messageId&&message.role==='user'):source.messages.length;
  if(index<0)throw new HttpError(404,'原消息不存在。');
  let messages=structuredClone(source.messages.slice(0,index));
  if(!input.messageId){
    const turns=[...new Set(messages.map(message=>message.requestId))].slice(-6);
    messages=messages.filter(message=>turns.includes(message.requestId));
  }
  const chat={...structuredClone(source),id:id('chat'),title:(input.messageId?'编辑分支 · ':'续聊 · ')+source.title.slice(0,60),messages,status:'idle',archived:false,branchOf:chatId,editSourceMessageId:input.messageId||'',branchRequestId:input.requestId,createdAt:now(),updatedAt:now(),jobIds:[]};
  store.chats.push(chat);try{await store.persist();}catch(error){store.chats.pop();throw error;}return {chat};
}
