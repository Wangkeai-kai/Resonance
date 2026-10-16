import {randomUUID} from 'node:crypto';
export function desktopBrowser() {
  if(typeof process.send!=='function')return null;
  const pending=new Map();
  process.on('message',message=>{if(message?.type!=='gongming:browser-result')return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error('隔离浏览器测试未能完成，请查看桌面诊断并重试。')):request.resolve(message.result);});
  return (html,steps=[])=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('浏览器测试等待超时，未标记为通过。'));},20000);pending.set(id,{resolve,reject,timer});process.send({type:'gongming:browser-check',id,html,steps});});
}
