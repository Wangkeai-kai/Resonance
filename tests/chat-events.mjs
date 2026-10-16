import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatEvents,publicMessage} from '../lib/chat-events.mjs';
const chat=()=>({id:'chat-test',status:'idle',title:'fixture',messages:[{id:'message-one',role:'assistant',text:'',status:'pending',attachments:[]}]});

test('public message snapshots contain attachment references instead of image base64',()=>{
 const view=publicMessage('chat-one',{id:'message-one',fingerprint:'private-hash',attachments:[{type:'image',dataUrl:'data:image/png;base64,PRIVATE',mimeType:'image/png',bytes:123,name:'image.png'},{type:'link',url:'https://example.test'}]});
 assert.ok(!JSON.stringify(view).includes('PRIVATE'));assert.ok(!('fingerprint'in view));assert.equal(view.attachments[0].url,'/api/chats/chat-one/attachments/message-one/0');assert.equal(view.attachments[1].url,'https://example.test');
});
test('stream publishes text suffixes immediately, not a repeated full history',()=>{
 const hub=new ChatEvents(),value=chat(),events=[];const close=hub.subscribe(value,(type,data)=>events.push({type,data}));assert.equal(events[0].type,'snapshot');
 value.messages[0].text='你好';hub.publish(value,['message-one']);value.messages[0].text='你好，世界';hub.publish(value,['message-one']);
 assert.equal(events[1].data.messages[0].textDelta,'你好');assert.equal(events[2].data.messages[0].textDelta,'，世界');assert.ok(!('text'in events[2].data.messages[0]));assert.equal(events[2].data.seq,2);close();assert.equal(hub.connections,0);assert.equal(hub.topics.size,0);
});
test('replacements, final states and deletions are distinguishable from append deltas',()=>{
 const hub=new ChatEvents(),value=chat(),events=[];const close=hub.subscribe(value,(type,data)=>events.push({type,data}));value.messages[0].text='old';hub.publish(value);value.messages[0].text='new';hub.publish(value);assert.equal(events.at(-1).data.messages[0].text,'new');
 value.messages[0].status='completed';value.status='idle';hub.publish(value);assert.equal(events.at(-1).data.messages[0].status,'completed');assert.equal(events.at(-1).data.messages[0].textDelta,'');value.messages=[];hub.publish(value);assert.deepEqual(events.at(-1).data.removed,['message-one']);close();
});
test('reconnection gets a fresh authoritative snapshot and limits are released',()=>{
 const hub=new ChatEvents(),value=chat(),closers=[];
 for(let i=0;i<8;i++)closers.push(hub.subscribe(value,()=>{}));assert.throws(()=>hub.subscribe(value,()=>{}),{status:429});closers.forEach(close=>close());closers.forEach(close=>close());
 value.messages[0].text='finished while disconnected';let snapshot;const close=hub.subscribe(value,(type,data)=>{snapshot=data;});assert.equal(snapshot.chat.messages[0].text,value.messages[0].text);assert.equal(snapshot.seq,0);close();
});
test('reconnected topics have a new epoch so a fresh snapshot cannot be rejected as stale',()=>{
 const hub=new ChatEvents(),value=chat();let first,second;const close=hub.subscribe(value,(_event,data)=>{first=data;});value.messages[0].text='first';hub.publish(value);const oldEpoch=first.epoch;close();const next=hub.subscribe(value,(_event,data)=>{second=data;});assert.notEqual(second.epoch,oldEpoch);next();
 assert.throws(()=>hub.subscribe(value,()=>{throw Error('disconnected');}));assert.equal(hub.connections,0);assert.equal(hub.topics.size,0);
});
