import {randomUUID} from 'node:crypto';
export function desktopVault(){
  if(process.env.GONGMING_DESKTOP_VAULT!=='1'||!process.send)return null;
  const pending=new Map();
  process.on('message',message=>{if(message?.type!=='gongming:vault-result')return;const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error('系统加密存储不可用')):item.resolve(message.value);});
  const call=(operation,value)=>new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('系统加密存储未响应'));},10000);pending.set(id,{resolve,reject,timer});process.send({type:'gongming:vault',id,operation,value});});
  return {seal:text=>call('seal',text),unseal:text=>call('unseal',text)};
}
