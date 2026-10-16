import fs from 'node:fs';
import {createInterface} from 'node:readline';

// Keep a bounded window while scanning the append-only history. Old events stay
// on disk; startup and pagination never materialize the whole log in memory.
export async function readAuditLog(file,{limit=1000,before,jobId}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid audit page size');
  const recent=new Array(limit);let total=0,hasJobs=false,found=!before;
  const stream=fs.createReadStream(file,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      if(!line.trim())continue;
      const item=JSON.parse(line);if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid audit record');
      if(item.action==='job_created')hasJobs=true;
      if(before&&item.id===before){found=true;break;}
      if(jobId&&item.jobId!==jobId)continue;
      recent[total%limit]=item;total++;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  finally{lines.close();stream.destroy();}
  if(!found)throw Object.assign(new Error('审计游标已不存在，请重新读取最新记录。'),{status:409});
  const count=Math.min(total,limit),offset=total>=limit?total%limit:0;
  return {items:Array.from({length:count},(_,index)=>recent[(offset+index)%limit]),hasJobs,hasMore:total>limit};
}
