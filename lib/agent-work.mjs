import fs from 'node:fs/promises';
import path from 'node:path';
import {safePath,blockedSegment,secretFile} from './safety.mjs';

const sourceFile=name=>/\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|py|java|css|html|sql|go|rs|cs|xml|sh|vue|svelte|rb|php|c|h|cpp|svg)$/i.test(name);
export async function indexRepository(root,{maxEntries=20000}={}) {
  const paths=[];let truncated=false;
  async function walk(directory){
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(paths.length>=maxEntries){truncated=true;return;}
      if(entry.isSymbolicLink()||blockedSegment(entry.name)||secretFile(entry.name))continue;
      const absolute=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(absolute);
      else if(entry.isFile()&&sourceFile(entry.name)){const stat=await fs.stat(absolute);if(stat.nlink===1)paths.push(path.relative(root,absolute).replaceAll('\\','/'));}
    }
  }
  await walk(root);return {paths,truncated};
}
async function readFile(root,input) {
  if(!sourceFile(input.path||''))throw new Error('Agent 只可读取支持的文本源码。');
  const absolute=await safePath(root,input.path),stat=await fs.stat(absolute);
  if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('文件过大或不是普通文本文件，请按模块缩小范围。');
  const start=Number.isInteger(input.offset)?Math.max(0,input.offset):0,length=Math.min(24000,Math.max(1,Number.isInteger(input.length)?input.length:16000));
  const text=await fs.readFile(absolute,'utf8');if(text.includes('\0'))throw new Error('不能读取二进制文件。');
  return {path:input.path,offset:start,content:text.slice(start,start+length),totalChars:text.length,next:start+length<text.length?start+length:null};
}
async function tool(engine,job,task,action,index) {
  if(action.tool==='read')return readFile(task.worktree,action);
  if(action.tool==='list'){
    const offset=Math.max(0,Number.isInteger(action.offset)?action.offset:0),paths=index.paths.slice(offset,offset+150);
    return {paths,total:index.paths.length,truncated:index.truncated,next:offset+150<index.paths.length?offset+150:null};
  }
  if(action.tool==='search'){
    if(typeof action.query!=='string'||!action.query||action.query.length>200)throw new Error('检索词需为 1–200 字符的普通文本。');
    const offset=Math.max(0,Number.isInteger(action.offset)?action.offset:0),matches=[];let checked=0,bytes=0;
    for(const name of index.paths.slice(offset,offset+100)){
      checked++;const absolute=await safePath(task.worktree,name),stat=await fs.stat(absolute);
      if(stat.size>512000||bytes+stat.size>2*1024*1024)continue;bytes+=stat.size;
      const text=await fs.readFile(absolute,'utf8'),position=text.indexOf(action.query);
      if(position>=0)matches.push({path:name,line:text.slice(0,position).split('\n').length,snippet:text.slice(Math.max(0,position-300),position+1200)});
      if(matches.length>=12)break;
    }
    return {matches,checked,next:offset+checked<index.paths.length?offset+checked:null};
  }
  if(action.tool==='write'){
    await engine.writeFiles(job,task,action.files);
    for(const file of action.files){const name=file.path.replaceAll('\\','/');if(sourceFile(name)&&!index.paths.includes(name))index.paths.push(name);}
    index.paths.sort();
    return {written:action.files.map(file=>({path:file.path,bytes:Buffer.byteLength(file.content)}))};
  }
  throw new Error('Agent 请求了未授权工具。可用工具为 list、search、read、write；执行命令仍由测试和审批流程处理。');
}

export async function executeAgentWork(engine,job,task,instructions,common,maxTokens=10000) {
  const index=await indexRepository(task.worktree);
  const checkpoint=task.workCheckpoint||={version:1,step:0,observations:[],accepted:null,finished:false,result:null};
  if(checkpoint.finished)return checkpoint.result;
  const protocol='You may work iteratively using bounded tools. Respond {summary,done:boolean,actions:[{tool:"list",offset?}|{tool:"search",query,offset?}|{tool:"read",path,offset?,length?}|{tool:"write",files:[{path,content}]}],notes:[],risks:[]}. Use tools to inspect missing context and write complete files in focused batches, then continue until the assignment is complete. Only list/search/read/write exist. No shell, network, package installation, or fabricated test executions. A legacy {files:[{path,content}],summary,notes,risks} final response is also accepted. Finish only after necessary files are written. Available index paths do not imply their contents were read.';
  while(checkpoint.step<24){
    const signal=engine.active.get(job.id)?.signal;signal?.throwIfAborted();
    if(!checkpoint.accepted){
      const input={...common,index:index.paths.slice(0,500),indexCoverage:{available:index.paths.length,listed:Math.min(500,index.paths.length),truncated:index.truncated,next:index.paths.length>500?500:null},iteration:checkpoint.step+1,observations:checkpoint.observations.slice(-6),writtenFiles:(task.files||[]).map(file=>({path:file.path,bytes:Buffer.byteLength(file.content)}))};
      const response=await engine.model(job,task,instructions+' '+protocol,input,maxTokens);
      if(!response||typeof response!=='object'||Array.isArray(response))throw new Error('Agent 未返回有效的步骤对象。');
      if(!Array.isArray(response.actions||[]))throw new Error('Agent actions 必须为数组。');
      const actions=[...(response.files?.length?[{tool:'write',files:response.files}]:[]),...(response.actions||[])];
      if(actions.length>12)throw new Error('每轮最多 12 个受限工具操作。');
      checkpoint.accepted={response,actions,applied:0,results:[]};
      // Save the paid model output before applying tools. A restart can replay
      // these idempotent file actions without paying to regenerate the same step.
      await engine.persist();
    }
    const accepted=checkpoint.accepted;
    while(accepted.applied<accepted.actions.length){
      signal?.throwIfAborted();const action=accepted.actions[accepted.applied];
      const result=await tool(engine,job,task,action,index);
      accepted.results.push({tool:action.tool,result});accepted.applied++;
      await engine.record(job.id,task.id,'agent_tool_finished',{iteration:checkpoint.step+1,tool:action.tool,paths:action.tool==='write'?action.files.map(file=>file.path):action.path?[action.path]:[],readChars:result.content?.length});
      await engine.persist();
    }
    const response=accepted.response,done=response.done!==false&&(response.done===true||!response.actions?.length||response.actions.every(action=>action.tool==='write'));
    checkpoint.observations.push({step:checkpoint.step+1,summary:String(response.summary||'').slice(0,1000),results:accepted.results});checkpoint.observations=checkpoint.observations.slice(-6);checkpoint.step++;
    if(done){
      if(!task.files?.length)throw new Error('开发 Agent 结束时没有提供交付文件。');
      checkpoint.result={summary:String(response.summary||'已完成受限工具流程'),notes:Array.isArray(response.notes)?response.notes:[],risks:Array.isArray(response.risks)?response.risks:[],files:task.files.map(file=>({path:file.path,bytes:Buffer.byteLength(file.content)})),iterations:checkpoint.step};checkpoint.finished=true;checkpoint.accepted=null;await engine.persist();return checkpoint.result;
    }
    if(!accepted.actions.length)throw new Error('Agent 未提供下一步工具操作，请补充需求后继续。');
    checkpoint.accepted=null;await engine.persist();
  }
  throw new Error('本阶段已完成 24 轮受限工作，检查点已保存；请审阅成果后拆分下一项任务。');
}
