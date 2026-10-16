import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ChatAttachments} from '../lib/chat-attachments.mjs';
const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'resonance-blobs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('migrated images serialize as hash references, restart restores exact model inputs',async t=>{
  const root=await fixture(t),store=new ChatAttachments(root),chats=[{messages:[{attachments:[{type:'image',name:'参考.png',mimeType:'image/png',bytes:68,dataUrl}]}]}];
  const snapshot=store.snapshot(chats);assert.ok(!snapshot.json.includes('base64'));assert.equal(chats[0].messages[0].attachments[0].dataUrl,dataUrl);
  await snapshot.save();const reloaded=JSON.parse(snapshot.json);await new ChatAttachments(root).hydrate(reloaded.chats);
  assert.deepEqual(reloaded.chats,chats);
  const first=(await fs.stat(path.join(root,'chat-attachments',(await fs.readdir(path.join(root,'chat-attachments')))[0]))).mtimeMs;
  await store.snapshot(chats).save();assert.equal((await fs.stat(path.join(root,'chat-attachments',(await fs.readdir(path.join(root,'chat-attachments')))[0]))).mtimeMs,first);
});
test('identical images deduplicate and corrupted blobs cannot be silently accepted',async t=>{
  const root=await fixture(t),store=new ChatAttachments(root),image={type:'image',mimeType:'image/png',dataUrl},snapshot=store.snapshot([{messages:[{attachments:[image,{...image}]}]}]);
  await snapshot.save();const files=await fs.readdir(path.join(root,'chat-attachments'));assert.equal(files.length,1);
  await fs.writeFile(path.join(root,'chat-attachments',files[0]),'corrupted');
  await assert.rejects(new ChatAttachments(root).hydrate(JSON.parse(snapshot.json).chats),/校验失败/);
});
test('unsafe blob references and linked storage directories are rejected',async t=>{
  const root=await fixture(t),store=new ChatAttachments(root);
  await assert.rejects(store.hydrate([{messages:[{attachments:[{type:'image',mimeType:'image/png',blobId:'../state.json'}]}]}]),/引用无效/);
  const outside=path.join(root,'elsewhere');await fs.mkdir(outside);await fs.symlink(outside,path.join(root,'chat-attachments'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(store.snapshot([{messages:[{attachments:[{type:'image',mimeType:'image/png',dataUrl}]}]}]).save(),/目录不可用/);
});
