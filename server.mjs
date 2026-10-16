import http from 'node:http';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './lib/engine.mjs';
import { HttpError,isWithin } from './lib/safety.mjs';
import { PRESETS, detectLocalProviders } from './lib/providers.mjs';
import {WORKFLOWS} from './lib/workflows.mjs';
import {workflowReview,applyWorkflowReview} from './lib/workflow-review.mjs';
import {ChatGPTConnection} from './lib/chatgpt.mjs';
import {attachProviderVault} from './lib/provider-vault.mjs';
import {desktopVault} from './lib/desktop-vault.mjs';
import {createHash} from 'node:crypto';
import {connectionCandidate,discoverModels} from './lib/providers.mjs';
import {ChatStore} from './lib/chat.mjs';
import {Extensions} from './lib/extensions.mjs';
import {readAuditLog} from './lib/audit-log.mjs';
import {isConversationQuestion} from './lib/request-intent.mjs';
import {serveChatStream} from './lib/chat-events.mjs';
import {desktopBrowser} from './lib/desktop-browser.mjs';
import {WorkflowLibrary} from './lib/workflow-library.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const portIndex=process.argv.indexOf('--port');
const port=Number(portIndex>=0?process.argv[portIndex+1]:process.env.PORT || 4173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid --port');
const engine=new Engine(root,{dataDirectory:process.env.GONGMING_DATA_DIR});
const vault=desktopVault();
const chatgpt=new ChatGPTConnection(engine.runtime,{vault});
let chats,extensions,workflowLibrary;
try {
  // This owner lock protects all workspace writes, including startup recovery.
  // Keep its old filename so existing desktop backends also exclude this process.
  await chatgpt.init();
  await engine.init();
  engine.browserTester=desktopBrowser();
  await attachProviderVault(engine,vault);
  engine.gateway.chatgpt=chatgpt;
  chats=await new ChatStore(engine).init();
  extensions=await new Extensions(engine,{vault}).init();
  workflowLibrary=await new WorkflowLibrary(engine).init();
} catch(error) {
  await chatgpt.close();
  const code=error.code==='chatgpt_runtime_in_use'?'workspace_in_use':['history_recovery_required','state_invalid','chat_invalid','workflow_library_invalid'].includes(error.code)?error.code:'startup_failed';
  console.error('GONGMING_STARTUP_ERROR:'+JSON.stringify({code}));
  throw new Error('本地工作区启动失败：'+code);
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
const json=(response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data));};
const body=async(request,limit=1024*1024)=>{let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>limit)throw new HttpError(413,`请求体超过 ${limit/1024/1024} MB`);chunks.push(chunk);}try{const text=Buffer.concat(chunks).toString('utf8');return text?JSON.parse(text):{};}catch{throw new HttpError(400,'请求不是有效 JSON');}};
const server=http.createServer(async(request,response)=>{
  response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Frame-Options','DENY');
  try{
    const host=request.headers.host || '';
    if(![`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(host))throw new HttpError(403,'Only loopback hosts are allowed');
    const url=new URL(request.url,`http://${host}`);
    if(request.headers.origin && request.headers.origin!==`http://${host}`)throw new HttpError(403,'跨站请求已拒绝');
    if(url.pathname.startsWith('/api/')){
      if(request.method==='OPTIONS')throw new HttpError(403,'Cross-origin API access is disabled');
      if(request.method==='POST'&&!String(request.headers['content-type']||'').includes('application/json'))throw new HttpError(415,'API 写操作要求 application/json');
      if(request.method==='GET'&&url.pathname==='/api/extensions')return json(response,200,extensions.status());
      if(request.method==='POST'&&url.pathname==='/api/skills')return json(response,200,await extensions.skill(await body(request)));
      if(request.method==='POST'&&url.pathname==='/api/mcp/connect')return json(response,200,await extensions.connect(await body(request)));
      if(request.method==='POST'&&url.pathname==='/api/mcp/remove')return json(response,200,await extensions.remove(await body(request)));
      if(request.method==='POST'&&url.pathname==='/api/mcp/prepare')return json(response,200,await extensions.prepare(await body(request)));
      if(request.method==='POST'&&url.pathname==='/api/mcp/call')return json(response,200,await extensions.call(await body(request)));
      if(request.method==='GET'&&url.pathname==='/api/chatgpt/status')return json(response,200,chatgpt.status());
      if(request.method==='POST'&&url.pathname==='/api/chatgpt/start'){const input=await body(request);return json(response,200,await chatgpt.start(input.accountId));}
      if(request.method==='POST'&&url.pathname==='/api/chatgpt/models'){const input=await body(request);return json(response,200,{models:await chatgpt.models(input.accountId)});}
      if(request.method==='POST'&&url.pathname==='/api/chatgpt/logout'){if(engine.active.size)throw new HttpError(409,'请等待回复完成或暂停任务后退出账号');const input=await body(request);return json(response,200,await chatgpt.logout(input.accountId));}
      if(request.method==='POST'&&url.pathname==='/api/chatgpt/connect'){
        const input=await body(request);
        return json(response,200,await engine.queueConfig(async()=>{
          const account=chatgpt.status().accounts.find(a=>a.id===input.accountId);if(!account?.connected||!account.planEnabled)throw new HttpError(409,'请先登录并授权 ChatGPT 套餐使用');
          const model=account.models.find(m=>m.id===input.model);if(!model)throw new HttpError(400,'请选择账号返回的模型');
          const id='plan-'+createHash('sha256').update(account.id+'|'+model.id).digest('hex').slice(0,28);
          const provider={id,type:'chatgpt-plan',accountId:account.id,baseUrl:'https://api.openai.com/v1',model:model.id,name:'ChatGPT · '+model.name};
          const providers=engine.state.config.providers.filter(p=>p.id!==id).concat(provider),agentProviders={...engine.state.config.agentProviders};
          for(const agent of engine.status().agents)if(!agentProviders[agent.id])agentProviders[agent.id]=id;
          return {config:await engine.applyConfig({providers,agentProviders}),provider};
        }));
      }
      if(request.method==='POST'&&url.pathname==='/api/providers/models'){
        const input=await body(request);const {provider,apiKey}=connectionCandidate(input,engine.state.config.providers,engine.keys);
        try{return json(response,200,{models:await discoverModels(provider,apiKey)});}catch{throw new HttpError(400,'未能读取模型列表，请核对密钥，或手动填写服务商提供的模型 ID');}
      }
      if(request.method==='GET'&&url.pathname==='/api/audit')return json(response,200,await readAuditLog(path.join(engine.runtime,'audit.jsonl'),{limit:Math.max(1,Math.min(250,Number(url.searchParams.get('limit'))||100)),before:url.searchParams.get('before')||undefined,jobId:url.searchParams.get('jobId')||undefined}));
      if(request.method==='GET'&&url.pathname==='/api/status')return json(response,200,engine.status());
      if(request.method==='GET'&&url.pathname==='/api/chat-status') {
        const selected=url.searchParams.get('chatId'),ids=new Set(selected?(chats.get(selected).jobIds||[]):[]);
        const jobs=engine.state.jobs.filter(job=>ids.has(job.id)).map(job=>({id:job.id,brief:job.brief,status:job.status,reviewRequired:job.reviewRequired,suggestConversation:isConversationQuestion(job.brief),acceptance:job.tasks.find(task=>task.id==='regression'&&(task.status==='failed'||task.result?.reviewRequired))?.result?{summary:String(job.tasks.find(task=>task.id==='regression').result.summary||'').slice(0,500),missing:(job.tasks.find(task=>task.id==='regression').result.missing||[]).slice(0,5).map(value=>String(value).slice(0,200))}:undefined,recoveryIncomplete:job.recoveryIncomplete,tokens:job.tokens,workflow:job.workflow?{id:job.workflow.id,steps:job.workflow.steps}:undefined,deliverable:job.deliverable?.artifact?{artifact:true}:undefined,tasks:job.tasks.map(task=>({id:task.id,title:task.title,status:task.status,error:task.error,errorCode:task.errorCode,progress:task.progress,modelAssignment:task.modelAssignment}))}));
        return json(response,200,{mode:'local',config:engine.publicConfig(),jobs,approvals:engine.state.approvals.filter(item=>ids.has(item.jobId)&&item.status==='pending').map(({id,jobId,status,title,type})=>({id,jobId,status,title,type}))});
      }
      const attachmentMatch=url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9-]+)\/attachments\/([a-zA-Z0-9-]+)\/(\d{1,3})$/);
      if(attachmentMatch&&['GET','HEAD'].includes(request.method)) {
        const message=chats.get(attachmentMatch[1]).messages.find(item=>item.id===attachmentMatch[2]);
        const image=message?.attachments?.[Number(attachmentMatch[3])];
        if(image?.type!=='image'||typeof image.dataUrl!=='string')throw new HttpError(404,'图片不存在');
        const data=Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',')+1),'base64');
        response.writeHead(200,{'Content-Type':image.mimeType,'Content-Length':data.length,'Cache-Control':'private, max-age=86400','Content-Security-Policy':"default-src 'none'"});
        response.end(request.method==='HEAD'?undefined:data);return;
      }
      const streamMatch=url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9-]+)\/stream$/);
      if(request.method==='GET'&&streamMatch)return serveChatStream(request,response,chats,streamMatch[1]);
      if(request.method==='GET'&&url.pathname==='/api/chats'){const all=chats.list({archived:url.searchParams.get('archived')==='1'}),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);return json(response,200,{chats:all.slice(offset,offset+100),total:all.length,next:offset+100<all.length?offset+100:null});}
      if(request.method==='POST'&&url.pathname==='/api/chats/import'){const result=await chats.import(await body(request,40*1024*1024));return json(response,201,{chat:chats.events.view(result.chat)});}
      if(request.method==='POST'&&url.pathname==='/api/chats'){const chat=await chats.create(await body(request));return json(response,201,{chat:chats.events.view(chat)});}
      const chatMatch=url.pathname.match(/^\/api\/chats\/([a-zA-Z0-9-]+)(?:\/(messages|delete|job|stop|tasks|archive|export|fork|versions|regenerate))?$/);
      if(chatMatch){
        if(request.method==='GET'&&chatMatch[2]==='export'){response.setHeader('Content-Disposition','attachment; filename="gongming-conversation.json"');return json(response,200,chats.export(chatMatch[1]));}
        if(request.method==='POST'&&['archive','fork','versions','regenerate'].includes(chatMatch[2])){const input=await body(request);const method={archive:'archive',fork:'fork',versions:'selectVersion',regenerate:'regenerate'}[chatMatch[2]];const result=await chats[method](chatMatch[1],chatMatch[2]==='archive'?input.archived:input);return json(response,200,{...result,chat:chats.events.view(result.chat)});}

        if(request.method==='GET'&&!chatMatch[2])return json(response,200,{chat:chats.events.view(chats.get(chatMatch[1]))});
        if(request.method==='POST'&&chatMatch[2]==='messages'){const result=await chats.send(chatMatch[1],await body(request,8*1024*1024));return json(response,202,{...result,chat:chats.events.view(result.chat)});}
        if(request.method==='POST'&&chatMatch[2]==='tasks'){const result=await chats.startTask(chatMatch[1],await body(request));return json(response,202,{...result,chat:chats.events.view(result.chat)});}
        if(request.method==='POST'&&chatMatch[2]==='stop'){const result=await chats.stop(chatMatch[1]);return json(response,200,{...result,chat:chats.events.view(result.chat)});}
        if(request.method==='POST'&&chatMatch[2]==='delete')return json(response,200,await chats.remove(chatMatch[1]));
        if(request.method==='POST'&&chatMatch[2]==='job'){const input=await body(request),result=await chats.linkJob(chatMatch[1],input.jobId);return json(response,200,{...result,chat:chats.events.view(result.chat)});}
      }
      if(request.method==='GET'&&url.pathname==='/api/workflows')return json(response,200,{workflows:WORKFLOWS});
      if(request.method==='GET'&&url.pathname==='/api/workflow-library')return json(response,200,workflowLibrary.status());
      if(request.method==='POST'&&url.pathname==='/api/workflow-library')return json(response,201,await workflowLibrary.create(await body(request,128*1024)));
      const libraryMatch=url.pathname.match(/^\/api\/workflow-library\/([a-zA-Z0-9-]+)(?:\/(export|prepare))?$/);
      if(libraryMatch){
        if(request.method==='GET'&&libraryMatch[2]==='export'){response.setHeader('Content-Disposition','attachment; filename="workflow.gmflow.json"');return json(response,200,workflowLibrary.export(libraryMatch[1]));}
        if(request.method==='POST'&&libraryMatch[2]==='prepare')return json(response,200,workflowLibrary.prepare(libraryMatch[1],await body(request,256*1024)));
        if(request.method==='POST'&&!libraryMatch[2])return json(response,200,await workflowLibrary.update(libraryMatch[1],await body(request,128*1024)));
        if(request.method==='DELETE'&&!libraryMatch[2])return json(response,200,await workflowLibrary.remove(libraryMatch[1]));
      }
      if(request.method==='GET'&&url.pathname==='/api/providers')return json(response,200,{presets:PRESETS.map(p=>({...p,local:['ollama','lmstudio'].includes(p.id),keyRequired:!['ollama','lmstudio'].includes(p.id)}))});
      if(request.method==='GET'&&url.pathname==='/api/providers/local')return json(response,200,await detectLocalProviders());
      if(request.method==='POST'&&url.pathname==='/api/providers/connect')return json(response,200,await engine.connect(await body(request)));
      if(request.method==='POST'&&url.pathname==='/api/requirements/analyze')return json(response,200,{analysis:await engine.analyze(await body(request))});
      if(request.method==='POST'&&url.pathname==='/api/config')return json(response,200,{config:await engine.config(await body(request))});
      if(request.method==='POST'&&url.pathname==='/api/config/test'){const input=await body(request);return json(response,200,await engine.gateway.test(input.provider));}
      if(request.method==='POST'&&url.pathname==='/api/jobs'){
        const input=await body(request);
        if(input.libraryWorkflowId){const item=workflowLibrary.get(input.libraryWorkflowId);if(item.definition.trigger.kind!==input.workflowId)throw new HttpError(400,'工作流库与执行模板类型不一致，请重新打开工作流','workflow_library_mismatch');}
        return json(response,202,{job:await engine.create(input)});
      }
      let match=url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)$/);
      if(request.method==='GET'&&match){const job=engine.job(match[1]);return json(response,200,{job,audit:engine.audit.filter(a=>a.jobId===job.id),approvals:engine.state.approvals.filter(a=>a.jobId===job.id)});}
      match=url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/actions$/);
      if(request.method==='POST'&&match){const input=await body(request);return json(response,200,await engine.actions(engine.job(match[1]),input.action));}
      match=url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/result$/);
      if(request.method==='GET'&&match){const job=engine.job(match[1]);const review=workflowReview(job);await engine.persist();return json(response,200,{job:{id:job.id,status:job.status,brief:job.brief,workflow:job.workflow,reviewRequired:job.reviewRequired,acceptance:job.tasks.find(task=>task.id==='regression')?.result,canReviewDraft:!engine.active.has(job.id)&&['failed','interrupted'].includes(job.status)&&job.tasks.some(task=>task.id==='tester'&&task.status==='completed'),checks:job.deliverable.checks,limitations:job.deliverable.limitations},review});}
      match=url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/review$/);
      if(request.method==='POST'&&match)return json(response,200,await applyWorkflowReview(engine,engine.job(match[1]),await body(request)));
      match=url.pathname.match(/^\/api\/approvals\/([a-zA-Z0-9-]+)$/);
      if(request.method==='GET'&&match){const approval=engine.state.approvals.find(item=>item.id===match[1]);if(!approval)throw new HttpError(404,'审批不存在');return json(response,200,{approval});}
      if(request.method==='POST'&&match){const input=await body(request);return json(response,200,await engine.decide(match[1],input.approved));}
      throw new HttpError(404,'API 路由不存在');
    }
    if(!['GET','HEAD'].includes(request.method))throw new HttpError(405,'Method not allowed');
    let relative=decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if(relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>part==='..'||part.startsWith('.')))throw new HttpError(403,'Invalid asset path');
    const dist=path.join(root,'dist'),target=path.resolve(dist,relative);if(!isWithin(dist,target))throw new HttpError(403,'Invalid asset path');
    let resolved;try{resolved=realpathSync(target);}catch{throw new HttpError(404,'文件不存在');}if(!isWithin(dist,resolved))throw new HttpError(403,'Asset symlink escapes dist');
    const data=await fs.readFile(resolved);response.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'"});response.end(request.method==='HEAD'?undefined:data);
  }catch(error){const message=engine.gateway.redact(error.message);if(!response.headersSent)json(response,error.status||500,{error:error.code||'request_failed',message});else response.end();}
});
server.requestTimeout=150000;server.headersTimeout=10000;
server.listen(port,'127.0.0.1',()=>console.log(`Review FM local collaboration: http://127.0.0.1:${port}\nLocal workspace and credential storage. State: ${engine.runtime}`));
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;for(const job of engine.state.jobs)if(engine.active.has(job.id))job.status='interrupted';for(const controller of engine.active.values())controller.abort();await chats.shutdown();await engine.persist();await engine.auditChain;await chatgpt.close({releaseOwner:false});server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
process.on('message',message=>{if(message?.type==='gongming:shutdown')shutdown();});
