import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const digest=data=>createHash('sha256').update(data).digest('hex');
const mimeTypes=new Set(['image/png','image/jpeg','image/webp']);

// Content-addressed image files keep each streaming snapshot small. Old inline
// images are migrated only after all referenced blobs have been saved. Files
// are retained for previous-snapshot recovery; no automatic destructive GC.
export class ChatAttachments {
  constructor(runtime){this.directory=path.join(runtime,'chat-attachments');this.cache=new WeakMap();this.ready=null;this.directoryIdentity=null;}
  async ensureDirectory(){
    this.ready||=fs.mkdir(this.directory,{recursive:true,mode:0o700});await this.ready;
    const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('图片存储目录不可用');
    const identity=stat.dev+':'+stat.ino;
    if(this.directoryIdentity&&this.directoryIdentity!==identity)throw new Error('图片存储目录已改变，请重启后检查完整备份');
    this.directoryIdentity=identity;
  }
  async readBlob(file,id){
    await this.ensureDirectory();
    const before=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>5*1024*1024)throw new Error('图片文件无效');
    const handle=await fs.open(file,'r');
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.dev!==before.dev||stat.ino!==before.ino||stat.size>5*1024*1024)throw new Error('图片文件已改变');
      const data=await handle.readFile();if(data.length>5*1024*1024||digest(data)!==id)throw new Error('图片文件校验失败，请从完整备份恢复');return data;
    }finally{await handle.close();}
  }
  snapshot(chats){
    const writes=new Map();let hasImages=false;
    const json=JSON.stringify({version:1,chats},(_name,value)=>{
      if(value?.type!=='image'||typeof value.dataUrl!=='string')return value;
      hasImages=true;
      let cached=this.cache.get(value);
      if(!cached||cached.dataUrl!==value.dataUrl){
        const match=value.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
        if(!match)throw new Error('图片数据无效');
        const data=Buffer.from(match[2],'base64');if(data.toString('base64')!==match[2])throw new Error('图片 Base64 编码无效');if(data.length>5*1024*1024)throw new Error('图片过大');
        cached={dataUrl:value.dataUrl,mimeType:match[1],bytes:data.length,blobId:digest(data),data,saved:false};this.cache.set(value,cached);
      }
      const {dataUrl,blobId,...metadata}=value;
      cached.reference={...metadata,mimeType:cached.mimeType,bytes:cached.bytes,blobId:cached.blobId};
      if(!cached.saved)writes.set(cached.reference.blobId,cached);
      return cached.reference;
    });
    return {json,save:async()=>{
      if(!hasImages)return;
      await this.ensureDirectory();
      for(const [id,item]of writes){
        const file=path.join(this.directory,id+'.blob');
        const stat=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(stat){await this.readBlob(file,id);}
        else{
          const temporary=path.join(this.directory,id+'.'+randomUUID()+'.tmp');
          const handle=await fs.open(temporary,'wx',0o600);
          try{
            try{await handle.writeFile(item.data);await handle.sync();}finally{await handle.close();}
            await this.ensureDirectory();await fs.rename(temporary,file);
          }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
        }
        item.saved=true;delete item.data;
      }
    }};
  }
  async hydrate(chats){
    for(const chat of chats){
      let bytes=0;
      for(const message of chat.messages||[])for(const image of message.attachments||[]){
        if(image.type!=='image'||!image.blobId)continue;
        if(!/^[a-f0-9]{64}$/.test(image.blobId)||!mimeTypes.has(image.mimeType))throw new Error('图片引用无效');
        await this.ensureDirectory();
        const file=path.join(this.directory,image.blobId+'.blob'),data=await this.readBlob(file,image.blobId);
        bytes+=data.length;if(bytes>20*1024*1024)throw new Error('会话图片超出存储限制');
        const blobId=image.blobId;image.bytes=data.length;image.dataUrl='data:'+image.mimeType+';base64,'+data.toString('base64');delete image.blobId;
        this.cache.set(image,{dataUrl:image.dataUrl,mimeType:image.mimeType,bytes:data.length,blobId,saved:true});
      }
    }
  }
}
