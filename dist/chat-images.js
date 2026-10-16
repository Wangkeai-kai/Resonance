(() => {
  'use strict';
  const dataUrl=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(blob);});
  async function prepare(file,onProgress=()=>{}) {
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('支持 PNG、JPG、WebP 图片');
    if(file.size>20*1024*1024)throw new Error('单张原图不能超过 20 MB');
    onProgress('正在检查图片…');
    const header=new DataView(await file.slice(0,32).arrayBuffer());
    if(file.type==='image/png'&&header.byteLength>=24&&header.getUint32(0)===0x89504e47&&header.getUint32(16)*header.getUint32(20)>40000000)throw new Error('图片像素过大，请先裁剪至 4000 万像素以内');
    let bitmap;
    try {
      bitmap=await createImageBitmap(file);
      if(bitmap.width*bitmap.height>40000000)throw new Error('图片像素过大，请先裁剪至 4000 万像素以内');
      let blob=file;
      if(file.size>1024*1024||Math.max(bitmap.width,bitmap.height)>2400){
        onProgress('正在缩放与压缩，完成后可在附件中预览…');
        const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
        canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
        const compressed=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.92));
        if(compressed&&(compressed.size<file.size||scale<1))blob=compressed;
      }
      onProgress('正在准备附件…');
      return {type:'image',name:file.name||'粘贴的图片',mimeType:blob.type,dataUrl:await dataUrl(blob),bytes:blob.size};
    }catch(error){throw new Error(error.message||'无法解码图片，请换一张 PNG、JPG 或 WebP 图片');}
    finally{bitmap?.close();onProgress('');}
  }
  window.ChatImages=Object.freeze({prepare});
})();
