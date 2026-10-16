import {id,now,HttpError} from './safety.mjs';
import {CHAT_LIMITS} from './chat.mjs';

const fields=['text','status','phase','error','errorCode','providerId','providerName','model','usage','truncated','finishReason','completedAt','sourceFingerprint'];
export function captureVersion(message) {
  if(!message.versionId||message.status==='pending')return;
  message.versions||=[];
  const value={id:message.versionId};for(const name of fields)if(message[name]!==undefined)value[name]=structuredClone(message[name]);
  const index=message.versions.findIndex(item=>item.id===message.versionId);
  if(index<0)message.versions.push(value);else message.versions[index]=value;
}
export function beginVersion(message) {
  message.versionId ||= id('version');captureVersion(message);
  if(message.versions.length>=20)throw new HttpError(409,'本条回复已保存 20 个版本。可以分支续聊，原版本会保留。');
  message.versionId=id('version');
}
export async function selectVersion(store,chatId,input) {
  const chat=store.get(chatId);if(store.active.has(chatId))throw new HttpError(409,'回复结束后才能切换版本。');
  const message=chat.messages.find(item=>item.id===input.messageId&&item.role==='assistant');
  const version=Number.isInteger(input.index)?message?.versions?.[input.index]:null;if(!version)throw new HttpError(404,'回复版本不存在。');
  if(message.versionId===version.id)return {chat};
  const messageIndex=chat.messages.indexOf(message);
  const nextTurn=chat.messages.findIndex((item,index)=>index>messageIndex&&item.role==='user'&&item.requestId!==message.requestId);
  // Later answers were generated against the original version. Keep that
  // history exact and start an explicit branch at the changed turn instead.
  if(nextTurn>=0){
    const existing=store.chats.find(item=>item.branchOf===chatId&&item.versionSourceMessageId===message.id&&item.versionSourceId===version.id);
    if(existing)return {chat:existing,branched:true,reused:true};
    if(store.chats.filter(item=>!item.archived).length>=CHAT_LIMITS.chats)throw new HttpError(409,'最近会话已满，请先归档不常用的会话后再创建版本分支。');
    const branch={...structuredClone(chat),id:id('chat'),title:'版本分支 · '+chat.title.slice(0,60),messages:structuredClone(chat.messages.slice(0,nextTurn)),status:'idle',archived:false,branchOf:chatId,versionSourceMessageId:message.id,versionSourceId:version.id,jobIds:[],generationRequests:[],createdAt:now(),updatedAt:now()};
    delete branch.branchRequestId;delete branch.editSourceMessageId;
    applyVersion(branch,branch.messages.find(item=>item.id===message.id),version);
    store.chats.push(branch);try{await store.persist();}catch(error){store.chats.splice(store.chats.indexOf(branch),1);throw error;}
    return {chat:branch,branched:true};
  }
  const previous=structuredClone(chat);
  applyVersion(chat,message,version);chat.updatedAt=now();
  try{await store.persist();}catch(error){for(const key of Object.keys(chat))delete chat[key];Object.assign(chat,previous);throw error;}return {chat};
}
function applyVersion(chat,message,version) {
  const messageId=message.id,versions=message.versions;
  for(const name of fields)delete message[name];Object.assign(message,structuredClone(version),{id:messageId,versionId:version.id,versions});
  if(message.purpose==='discussion')for(const summary of chat.messages.filter(item=>item.requestId===message.requestId&&item.purpose==='summary'))summary.sourcesChanged=true;
}
export async function regenerate(store,chatId,input) {
  const chat=store.get(chatId);if(store.active.has(chatId))throw new HttpError(409,'请先停止或等待当前回复。');
  if(typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId))throw new HttpError(400,'重新生成请求编号无效。');
  const message=chat.messages.find(item=>item.id===input.messageId&&item.role==='assistant'),user=chat.messages.filter(item=>item.role==='user').at(-1);
  if(!message||message.requestId!==user?.requestId)throw new HttpError(409,'较早的回复请通过编辑分支继续，以保留后续上下文。');
  const prior=chat.generationRequests?.find(item=>item.id===input.requestId);
  if(prior){if(prior.messageId!==message.id)throw new HttpError(409,'请求编号已用于另一条回复。');return {chat,reused:true};}
  store.provider(message.providerId);
  const old=structuredClone(message);beginVersion(message);
  message.status='interrupted';message.retryBlocked=false;message.error='用户主动重新生成';
  chat.generationRequests||=[];chat.generationRequests.push({id:input.requestId,messageId:message.id});
  const payload={requestId:user.requestId,text:user.text,attachments:user.attachments,retry:true,...(chat.kind==='team'?{recipientIds:user.recipientIds,summarize:user.summarize}:{providerId:message.providerId})};
  try{return await store.sendInternal(chatId,payload);}catch(error){Object.assign(message,old);chat.generationRequests.pop();throw error;}
}
