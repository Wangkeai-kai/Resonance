import {selectSkills,skillRefs} from './builtin-skills.mjs';
import {AuditLog} from './audit-log.mjs';
import {executeAgentWork} from './agent-work.mjs';
import {expandCoordination,specialistInstructions,planningInstruction} from './coordination.mjs';
import fs from 'node:fs/promises';
import {saveSnapshot,exists} from './local-snapshot.mjs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { id,now,hash,HttpError,readContext,safePath,runCommand,isWithin,validateProvider } from './safety.mjs';
import { ModelGateway } from './models.mjs';
import { connectionCandidate, discoverModels, chooseModel, inferKind, isLocalUrl } from './providers.mjs';
import {buildWorkflow,stageInstructions,validateWorkflowArtifact} from './workflows.mjs';

export const AGENTS = [
  {id:'orchestrator',name:'调度总 Agent',role:'拆解需求，协调阶段依赖与预算'},
  {id:'architect',name:'架构设计 Agent',role:'模块、接口、目录与风险设计'},
  {id:'context',name:'代码库检索 Agent',role:'有边界源码检索与依赖分析'},
  {id:'frontend',name:'前端 Agent',role:'按总控和架构方案实现前端'},
  {id:'backend',name:'后端 Agent',role:'按总控和共享接口实现后端'},
  {id:'developer',name:'开发 Agent',role:'在独立 Git 工作树编写成果'},
  {id:'tester',name:'自动化测试 Agent',role:'生成测试，审批后执行并反馈'},
  {id:'git',name:'Git 工作流 Agent',role:'分支、差异、提交及合并审批'},
  {id:'sandbox',name:'沙盒执行 Agent',role:'无网络、只读挂载的 Docker 执行'},
  {id:'docs',name:'文档维护 Agent',role:'同步 README 与接口文档'},
  {id:'regression',name:'回归校验 Agent',role:'对照原始需求验收，标记缺失项'},
];
const STAGES = [
  ['orchestrator','需求拆解',[]],['context','代码库检索',['orchestrator']],['architect','架构与风险设计',['orchestrator']],
  ['developer','开发交付',['context','architect']],['tester','生成并执行测试',['developer']],['docs','同步文档',['developer']],
  ['regression','原始需求验收',['tester','docs']],['git','Git 变更清单',['regression']],
];
export class Engine {
  constructor(root, options = {}) { this.root=root;this.runtime=options.dataDirectory ? path.resolve(options.dataDirectory) : path.join(root,'.runtime');this.state={version:1,config:{projectPath:'',providers:[],agentProviders:{}},jobs:[],analyses:[],skills:[],approvals:[]};this.keys=new Map();this.audit=[];this.auditStore=new AuditLog(path.join(this.runtime,'audit.jsonl'));this.active=new Map();this.persistChain=Promise.resolve();this.auditChain=Promise.resolve();this.configChain=Promise.resolve();this.gateway=new ModelGateway(this.state,this.keys,this.record.bind(this));this.capabilities={git:false,docker:false,model:false}; }
  async init() {
    await fs.mkdir(path.join(this.runtime,'worktrees'),{recursive:true});await fs.mkdir(path.join(this.runtime,'empty-hooks'),{recursive:true});
    let stateMissing=false;
    try {
      const saved=JSON.parse(await fs.readFile(path.join(this.runtime,'state.json'),'utf8'));
      if(saved.version!==1||!saved.config||!Array.isArray(saved.config.providers)||!saved.config.agentProviders||!Array.isArray(saved.jobs)||!Array.isArray(saved.approvals)||saved.jobs.some(job=>!job||typeof job.id!=='string'||!Array.isArray(job.tasks)))throw new Error('本地记录版本或格式不兼容，请保留原文件并恢复，不能重置为空工作区');
      Object.assign(this.state,saved);
    } catch(e) { if(e.code!=='ENOENT')throw Object.assign(new Error('Cannot read saved state: '+e.message),{code:'state_invalid'});stateMissing=true; }
    let audit=[],historicalJobs=false;
    try { const savedAudit=await this.auditStore.read();audit=savedAudit.items;historicalJobs=savedAudit.hasJobs; }
    catch(e) { if(e.code!=='ENOENT')throw Object.assign(new Error('Cannot read audit log: '+e.message),{code:'state_invalid'}); }

    if((stateMissing&&(await exists(path.join(this.runtime,'state.previous.json'))||(await fs.readdir(path.join(this.runtime,'worktrees'))).length))||(!this.state.jobs.length&&historicalJobs))throw Object.assign(new Error('发现历史任务，但主记录缺失或为空。请保留本地文件并恢复历史，不能创建空工作区。'),{code:'history_recovery_required'});
    this.audit=audit.slice(-1000);
    for(const job of this.state.jobs) { if(['running','queued'].includes(job.status))job.status='interrupted';for(const task of job.tasks)if(task.status==='running'){task.status='interrupted';task.error='服务已重启；已完成阶段保留，请手动继续。';} }
    for(const approval of this.state.approvals)if(approval.status==='running'){approval.status='unknown';approval.result={error:'服务在动作执行中重启，执行结果未知。请检查工作树或 Git 状态，禁止自动重跑。'};const job=this.job(approval.jobId);job.status='interrupted';}
    this.capabilities.git=(await runCommand('git',['--version']).catch(()=>({code:1}))).code===0;
    this.capabilities.docker=(await runCommand('docker',['info','--format','{{.ServerVersion}}'],{timeout:5000}).catch(()=>({code:1}))).code===0;
    await this.persist();return this;
  }
  persist() { const snapshot=JSON.stringify(this.state,null,2);this.persistChain=this.persistChain.catch(()=>{}).then(()=>saveSnapshot(path.join(this.runtime,'state.json'),snapshot));return this.persistChain; }
  async record(jobId,agentId,action,details={}) {
    const item={id:id('audit'),at:now(),jobId,agentId,action,details:JSON.parse(this.gateway.redact(JSON.stringify(details)))};
    this.auditChain=this.auditChain.catch(()=>{}).then(()=>this.auditStore.append(item));
    await this.auditChain;
    this.audit.push(item);if(this.audit.length>1000)this.audit.shift();
    return item;
  }
  readAudit(options) {
    const result=this.auditChain.then(()=>this.auditStore.read(options));
    this.auditChain=result.then(()=>{},()=>{});
    return result;
  }
  publicConfig() { return {...this.state.config,credentialStorage:this.credentialStorage||'memory',baseUrl:this.state.config.providers[0]?.baseUrl || '',model:this.state.config.providers[0]?.model || '',providers:this.state.config.providers.map(p=>({...p,hasKey:this.keys.has(p.id),...(p.type==='chatgpt-plan'?{connected:!!this.gateway.chatgpt?.connected(p.accountId)}:{})}))}; }
  status() { let model=false;try{this.gateway.provider('orchestrator');model=true;}catch{}return {mode:'local',capabilities:{...this.capabilities,model},agents:AGENTS,config:this.publicConfig(),jobs:this.state.jobs,analyses:this.state.analyses,skills:this.state.skills,audit:this.audit.slice(-250),approvals:this.state.approvals}; }
  // Serialize connection tests and configuration writes so concurrent additions
  // cannot overwrite each other or spend tokens after the connection limit.
  queueConfig(operation) { const result=this.configChain.then(operation);this.configChain=result.catch(()=>{});return result; }
  config(input) { return this.queueConfig(()=>this.applyConfig(input)); }
  async applyConfig(input) {
    if(this.active.size)throw new HttpError(409,'请先暂停运行中的任务，再更改模型或项目配置');
    let providers=input.providers;
    if(!providers && (input.baseUrl || input.model))providers=[{id:'default',name:'默认模型',type:'openai',baseUrl:input.baseUrl || this.state.config.providers[0]?.baseUrl,model:input.model || this.state.config.providers[0]?.model,...('apiKey' in input ? {apiKey:input.apiKey}: {})}];
    const previousProviders=this.state.config.providers;
    const next={...this.state.config,agentProviders:{...this.state.config.agentProviders}};
    if(providers) { if(!Array.isArray(providers) || providers.length>12)throw new HttpError(400,'最多支持 12 个模型连接');const checked=providers.map(validateProvider);if(new Set(checked.map(p=>p.id)).size!==checked.length)throw new HttpError(400,'模型连接 id 重复');next.providers=checked; }
    if('projectPath' in input) { const project=String(input.projectPath||'').trim();if(project){let real;try{real=realpathSync(project);}catch(error){throw new HttpError(400,`无法访问项目目录：${error.code}`);}if(real===path.parse(real).root)throw new HttpError(400,'不能将磁盘根目录设为项目');const stat=await fs.stat(real);if(!stat.isDirectory())throw new HttpError(400,'项目必须为目录');next.projectPath=real;}else next.projectPath=''; }
    if('approvalMode' in input){if(!['ask','auto_sandbox'].includes(input.approvalMode))throw new HttpError(400,'审批方式无效');next.approvalMode=input.approvalMode;}
    if(input.agentProviders){if(typeof input.agentProviders!=='object'||Array.isArray(input.agentProviders))throw new HttpError(400,'agentProviders 必须为映射');next.agentProviders={};for(const [agent,provider]of Object.entries(input.agentProviders)){if(!AGENTS.some(a=>a.id===agent)||!next.providers.some(p=>p.id===provider))throw new HttpError(400,'Agent 或模型连接不存在');next.agentProviders[agent]=provider;} }
    for(const [agent,provider] of Object.entries(next.agentProviders))if(!next.providers.some(p=>p.id===provider))delete next.agentProviders[agent];
    Object.assign(this.state.config,next);
    if(providers) { for(const p of providers){const old=previousProviders.find(previous=>previous.id===p.id),current=next.providers.find(provider=>provider.id===p.id);if('apiKey' in p){if(p.apiKey)this.keys.set(p.id,String(p.apiKey));else this.keys.delete(p.id);}else if(old&&(old.baseUrl!==current.baseUrl||old.type!==current.type))this.keys.delete(p.id);}for(const key of this.keys.keys())if(!next.providers.some(p=>p.id===key))this.keys.delete(key); }
    await this.record(null,'orchestrator','configuration_updated',{projectPath:next.projectPath,providers:next.providers.map(p=>({id:p.id,type:p.type,model:p.model})),agentProviders:next.agentProviders});await this.persist();return this.publicConfig();
  }
  connect(input) { return this.queueConfig(()=>this.connectProvider(input)); }
  async connectProvider(input) {
    if(this.active.size)throw new HttpError(409,'请先暂停运行中的任务，再连接模型');
    const {provider,apiKey,preset,explicitModel}=connectionCandidate(input,this.state.config.providers,this.keys);
    if(this.state.config.providers.length>=12 && !this.state.config.providers.some(p=>p.id===provider.id))throw new HttpError(400,'最多支持 12 个模型连接，请先移除不用的连接','connection_limit');
    // Candidate keys stay separate until the actual inference test succeeds.
    const candidateKeys=new Map(apiKey?[[provider.id,apiKey]]:[]);
    const candidateGateway=new ModelGateway({config:{providers:[provider],agentProviders:{}}},candidateKeys,async()=>{});
    try {
      if(!explicitModel){
        let models;
        try{models=await discoverModels(provider,apiKey);}
        catch{throw new HttpError(400,isLocalUrl(provider.baseUrl)?'未能读取本地模型列表。请启动服务并加载模型，或填写已加载的模型 ID。':'未能读取账号的模型列表。请核对服务地址与 API Key；若服务不支持模型列表，请手动填写服务商提供的模型 ID。');}
        provider.model=chooseModel(models);
        if(!provider.model)throw new HttpError(400,'列表中没有可用的文本模型；可手动填写服务商提供的模型 ID，再测试接口兼容性。');
      }
      provider.name=String(input.name||`${preset.name} · ${provider.model}`).trim().slice(0,80);
      const test=await candidateGateway.test(provider.id);
      const providers=this.state.config.providers.map(p=>p.id===provider.id?{...provider,apiKey}:p);
      if(!providers.some(p=>p.id===provider.id))providers.push({...provider,apiKey});
      const agentProviders={...this.state.config.agentProviders};
      for(const agent of AGENTS){if(['frontend','backend'].includes(agent.id))continue;const selected=providers.find(p=>p.id===agentProviders[agent.id]);let available=!!selected;if(selected && selected.id!==provider.id){try{this.gateway.providerById(selected.id);}catch{available=false;}}if(!available)agentProviders[agent.id]=provider.id;}
      const config=await this.applyConfig({providers,agentProviders});
      await this.record(null,'orchestrator','provider_connected',{id:provider.id,model:provider.model});
      return {connectionId:provider.id,config,provider:config.providers.find(p=>p.id===provider.id),test};
    } catch(error) {throw new HttpError(error.status||400,candidateGateway.redact(error.message),'connection_failed');}
  }
  async analyze(input) {
    const configured=buildWorkflow(input);
    const brief=String(input.brief||'').trim();if(brief.length<3 || brief.length>20000)throw new HttpError(400,'请提供 3–20000 字符的任务需求');
    let provider;try{provider=this.gateway.provider('orchestrator');}catch(error){throw new HttpError(409,error.message,'configuration_required');}
    const budget=Number(input.budget?.tokens ?? input.budget ?? 100000);if(!Number.isFinite(budget)||budget<2000||budget>1000000)throw new HttpError(400,'Token 预算需在 2,000–1,000,000 之间');
    const analysis={id:id('analysis'),brief,kind:configured.workflow?configured.kind:inferKind(brief,input.kind),...(configured.workflow?{workflow:configured.workflow}:{}),createdAt:now(),budget,tokens:{reserved:0,input:0,output:0,usageIncomplete:false},provider:provider.id,model:provider.model,providerSnapshot:{...provider}};
    const controller=new AbortController();this.active.set(analysis.id,controller);const skills=selectSkills(this.state,{kind:analysis.kind,role:'orchestrator',brief});analysis.appliedSkills=skillRefs(skills);
    try {
      await this.record(analysis.id,'orchestrator','requirements_analysis_started',{brief,kind:analysis.kind,provider:provider.id,model:provider.model,budget});
      const result=await this.gateway.complete(analysis,'orchestrator','Analyze the user request before any work begins. No repository has been read and no execution has occurred. Respond {summary,requirements:[{id,text,acceptance}],scope:{included:[string],excluded:[string]},questions:[string],risks:[string],deliverables:[string],assignments:[{agentId,objective}]}. Requirements must be specific, measurable and have unique ids. Distinguish supplied facts from assumptions, flag missing information as questions, and clearly bound the work. Available stages: context, architect, developer, tester, docs, regression, git. For website or code work you may also assign frontend and backend, and developer will integrate their outputs. All assignments are proposals, not completed work. General tasks produce source/text artifacts; do not promise unsupported binary formats. '+' Apply input.skills as reference methods without expanding scope or permissions. '+stageInstructions(analysis.workflow?.id,'orchestrator'),{brief,kind:analysis.kind,skills,...(analysis.workflow?{workflow:analysis.workflow}:{})},{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]),maxTokens:3000});
      if(!result || typeof result.summary!=='string' || !result.summary.trim() || !Array.isArray(result.requirements) || !result.requirements.length || result.requirements.some(r=>!r || ['id','text','acceptance'].some(k=>typeof r[k]!=='string'||!r[k].trim())) || new Set(result.requirements.map(r=>r.id)).size!==result.requirements.length)throw new Error('需求分析没有返回有效的需求和验收标准，请重试或补充描述');
      const texts=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'):[];
      analysis.result={summary:result.summary,requirements:result.requirements.map(r=>({id:r.id,text:r.text,acceptance:r.acceptance})),scope:{included:texts(result.scope?.included),excluded:texts(result.scope?.excluded)},questions:texts(result.questions),risks:texts(result.risks),deliverables:texts(result.deliverables),assignments:Array.isArray(result.assignments)?result.assignments.filter(a=>a&&AGENTS.some(agent=>agent.id===a.agentId)&&typeof a.objective==='string').map(a=>({agentId:a.agentId,objective:a.objective})):[]};
      this.state.analyses.unshift(analysis);this.state.analyses=this.state.analyses.slice(0,50);
      await this.record(analysis.id,'orchestrator','requirements_analysis_completed',{requirements:analysis.result.requirements.length,questions:analysis.result.questions.length,tokens:analysis.tokens});await this.persist();return analysis;
    }catch(error){const message=this.gateway.redact(error.message);await this.record(analysis.id,'orchestrator','requirements_analysis_failed',{error:message,tokens:analysis.tokens});throw new HttpError(error.status||400,message,'analysis_failed');}
    finally{this.active.delete(analysis.id);}
  }
  job(jobId) { const job=this.state.jobs.find(j=>j.id===jobId);if(!job)throw new HttpError(404,'任务不存在');return job; }
  async git(cwd,args,jobId=null,agent='git',mutating=false) {
    const commandArgs=['-c',`core.hooksPath=${path.join(this.runtime,'empty-hooks')}`,'-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args];
    const result=await runCommand('git',commandArgs,{cwd,timeout:60000,env:{GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true'}});
    if(mutating)await this.record(jobId,agent,'git_command',{command:'git',args,cwd,code:result.code,stdout:result.stdout.slice(0,3000),stderr:result.stderr.slice(0,3000)});
    if(result.code!==0)throw new Error(`Git ${args[0]} 失败: ${result.stderr || result.stdout}`);return result.stdout.trim();
  }
  create(input) {
    const operation=(this.creationChain||Promise.resolve()).then(()=>this.createJob(input));
    this.creationChain=operation.catch(()=>{});return operation;
  }
  async createJob(input) {
    if(input.libraryWorkflowId!==undefined&&(!input.workflowId||typeof input.libraryWorkflowId!=='string'||!/^(?:builtin-(?:ppt|website|document|project|code)|flow-[a-f0-9-]{36})$/.test(input.libraryWorkflowId)))throw new HttpError(400,'工作流来源编号无效');
    let requestFingerprint;
    if(input.requestId!==undefined){
      if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,100}$/.test(input.requestId))throw new HttpError(400,'任务请求编号无效');
      const {requestId,...requested}=input;requestFingerprint=hash(requested);
      const prior=this.state.jobs.find(job=>job.requestId===requestId);
      if(prior){if(prior.requestFingerprint!==requestFingerprint)throw new HttpError(409,'这次需求与之前的任务请求不同，请重新发送','request_conflict');return prior;}
    }
    const configured=buildWorkflow(input);
    const brief=String(input.brief||'').trim();if(brief.length<3 || brief.length>20000)throw new HttpError(400,'请提供 3–20000 字符的任务需求');
    try{this.gateway.provider('orchestrator');}catch(e){throw new HttpError(409,e.message,'configuration_required');}
    if(!this.capabilities.git)throw new HttpError(409,'请安装 Git 后运行协作任务','git_required');
    const budget=Number(input.budget?.tokens ?? input.budget ?? 100000);if(!Number.isFinite(budget)||budget<2000||budget>1000000)throw new HttpError(400,'Token 预算需在 2,000–1,000,000 之间');
    const jobId=id('job'),kind=configured.workflow?configured.kind:inferKind(brief,input.kind),managedWorkspace=!['code','review'].includes(kind)&&input.useProject!==true;
    let analysis=null;
    if(input.analysisId){analysis=this.state.analyses.find(a=>a.id===input.analysisId);if(!analysis)throw new HttpError(409,'需求分析已不存在，请重新分析或直接开始','analysis_not_found');if(analysis.brief!==brief || analysis.kind!==kind || hash(analysis.workflow||null)!==hash(configured.workflow||null))throw new HttpError(409,'需求、任务类型或模板参数已变化，请重新分析或直接开始','analysis_stale');if(analysis.tokens.reserved>=budget)throw new HttpError(400,'预算不足以继续任务，请提高预算；需求分析用量也计入任务','token_budget_exceeded');}
    // Analysis is a saved proposal, not a model connection. All remaining stages
    // must still have a usable current provider before any workspace is created.
    if(analysis)try{for(const [agent]of STAGES)if(agent!=='orchestrator')this.gateway.provider(agent);}catch(error){throw new HttpError(409,error.message,'configuration_required');}
    let root;
    if(managedWorkspace){
      root=path.join(this.runtime,'projects',jobId);await fs.mkdir(root,{recursive:true});
      await this.git(root,['init','--initial-branch=main'],jobId,'orchestrator',true);
      // Identity is repository-local; never change the user's global Git settings.
      await this.git(root,['config','--local','user.name','Gongming Workspace'],jobId,'orchestrator',true);
      await this.git(root,['config','--local','user.email','workspace@gongming.local'],jobId,'orchestrator',true);
      await fs.writeFile(path.join(root,'README.md'),'# Resonance 任务工作区\n\n任务成果与修改历史保存在本地。\n');
      await this.git(root,['add','--','README.md'],jobId,'orchestrator',true);
      await this.git(root,['commit','-m','Initialize private task workspace'],jobId,'orchestrator',true);
    }else{
      if(!this.state.config.projectPath)throw new HttpError(409,'修改已有代码前，请在更多选项选择项目目录','project_required');
      root=await this.git(this.state.config.projectPath,['rev-parse','--show-toplevel']).catch(()=>{throw new HttpError(400,'所选目录必须位于已有提交的 Git 仓库');});
    }
    const baseCommit=await this.git(root,['rev-parse','HEAD']);
    const job={id:jobId,coordinationVersion:1,brief,kind,managedWorkspace,approvalMode:this.state.config.approvalMode||'ask',status:'queued',createdAt:now(),updatedAt:now(),projectPath:root,baseCommit,budget,tokens:{reserved:0,input:0,output:0,usageIncomplete:false},tasks:STAGES.map(([agent,title,deps])=>({id:agent,agentId:agent,title,deps,status:deps.length?'blocked':'queued',result:null,error:null})),artifacts:[],summary:null,attempts:0,configSnapshot:{providers:this.state.config.providers.map(p=>({...p})),agentProviders:{...this.state.config.agentProviders}}};
    if(input.requestId){job.requestId=input.requestId;job.requestFingerprint=requestFingerprint;}
    if(input.sourceChatId)job.sourceChatId=input.sourceChatId;
    if(configured.workflow){job.workflow=configured.workflow;if(input.libraryWorkflowId)job.workflow.libraryWorkflowId=input.libraryWorkflowId;for(const [index,task]of job.tasks.entries())task.title=job.workflow.steps[index]||task.title;}
    if(analysis){job.analysisId=analysis.id;job.analysisProvider={...analysis.providerSnapshot};job.tokens={...analysis.tokens};Object.assign(job.tasks[0],{status:'completed',result:structuredClone(analysis.result),startedAt:analysis.createdAt,completedAt:analysis.createdAt,analysisId:analysis.id});if(analysis.provider&&analysis.model)job.tasks[0].modelAssignment={providerId:analysis.provider,name:analysis.providerSnapshot?.name||analysis.provider,model:analysis.model,role:'orchestrator'};await this.record(job.id,'orchestrator','requirements_analysis_reused',{analysisId:analysis.id,provider:analysis.provider,model:analysis.model,tokens:analysis.tokens});}
    this.state.jobs.unshift(job);await this.record(job.id,'orchestrator','job_created',{brief,kind:job.kind,baseCommit,projectPath:root,managedWorkspace,budget});await this.persist();this.run(job).catch(()=>{});return job;
  }
  predecessorFiles(job,task) {
    // Descendant edits replace ancestor output. Unrelated parallel edits still
    // conflict, and in-flight siblings must never change a stage's input.
    const precedes=(candidate,target)=>target.deps.includes(candidate.id)||target.deps.some(dep=>precedes(candidate,job.tasks.find(t=>t.id===dep)));
    const outputs=new Map();
    for(const predecessor of job.tasks)if(predecessor.status==='completed'&&precedes(predecessor,task))for(const file of predecessor.files || []){
      const previous=outputs.get(file.path);if(previous && !precedes(previous.task,predecessor) && previous.file.content!==file.content)throw new Error(`parallel_file_conflict: ${file.path} 同时被 ${previous.task.id} 和 ${predecessor.id} 修改，需人工合并`);
      outputs.set(file.path,{file,task:predecessor});
    }
    return [...outputs.values()].map(({file})=>file);
  }
  async workspace(job,task) {
    const destination=task.worktree || path.join(this.runtime,'worktrees',job.id,task.id);
    const branch=task.branch || `reviewfm/${job.id}/${task.id}`;
    if(!task.worktree){await fs.mkdir(path.dirname(destination),{recursive:true});await this.git(job.projectPath,['worktree','add','-b',branch,destination,job.baseCommit],job.id,task.id,true);task.worktree=destination;task.branch=branch;}
    // Integrate only completed predecessor outputs; every stage has an isolated worktree.
    const outputs=this.predecessorFiles(job,task);
    const inheritedHash=hash(outputs.map(file=>({path:file.path,hash:file.hash||hash(file.content)})));if(task.inheritedHash!==inheritedHash){if(task.inheritedHash&&task.workCheckpoint){task.previousCheckpoint=task.workCheckpoint;delete task.workCheckpoint;}for(const file of outputs) { const target=await safePath(destination,file.path,{writing:true});await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content); }task.inheritedHash=inheritedHash;}
    await this.record(job.id,task.id,'worktree_created',{path:destination,branch,baseCommit:job.baseCommit,inheritedFiles:outputs.map(file=>file.path)});return destination;
  }
  async writeFiles(job,task,files=[]) {
    if(!Array.isArray(files)||files.length>30)throw new Error('Model files must be an array of at most 30 entries');
    const validated=[];let total=0;const seen=new Set();
    for(const file of files) {
      if(typeof file.content!=='string'||typeof file.path!=='string')throw new Error('Each file requires path and text content');
      total+=Buffer.byteLength(file.content);if(total>350000)throw new Error('Generated files exceed 350 KB limit');
      if(seen.has(file.path))throw new Error(`Duplicate output path: ${file.path}`);seen.add(file.path);
      if(task.id==='tester'&&!/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:test|spec)\.[^.]+$/i.test(file.path))throw new Error('测试 Agent 仅可写 tests 目录或 test/spec 文件');
      if(task.id==='docs'&&!/\.(?:md|mdx|txt|rst|adoc)$/i.test(file.path))throw new Error('文档 Agent 仅可写文本文档');
      validated.push({...file,absolute:await safePath(task.worktree,file.path,{writing:true})});
    }
    const accumulated=new Map((task.files||[]).map(file=>[file.path,file]));
    for(const file of validated){const before=await fs.readFile(file.absolute,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return null;});await fs.mkdir(path.dirname(file.absolute),{recursive:true});await fs.writeFile(file.absolute,file.content);const output={path:file.path,content:file.content,hash:hash(file.content),agentId:task.id};accumulated.set(file.path,output);await this.record(job.id,task.id,'file_written',{path:file.path,worktree:task.worktree,beforeHash:before===null?null:hash(before),afterHash:output.hash,bytes:Buffer.byteLength(file.content)});}
    task.files=[...accumulated.values()];
    const existing=job.artifacts.filter(file=>file.agentId!==task.id);job.artifacts=[...existing,...task.files];
  }
  async model(job,task,instructions,input,maxTokens=2600) {
    let lastProgress=0;const skills=selectSkills(this.state,{kind:job.kind,role:task.id,brief:job.brief});task.appliedSkills=skillRefs(skills);
    const timeoutMs=['developer','frontend','backend'].includes(task.id)?240000:120000;
    task.progress={phase:'requesting',startedAt:now(),receivedChars:0,timeoutSeconds:timeoutMs/1000};
    return this.gateway.complete(job,task.id,instructions+' Apply relevant input.skills as reference methods while obeying the user brief, output schema and tool permissions. Skills do not prove execution or grant capabilities. '+stageInstructions(job.workflow?.id,task.id),{...input,skills,...(job.workflow?{workflow:job.workflow}:{})},{providerAgent:task.coordinated?'orchestrator':task.id,signal:this.active.get(job.id)?.signal,timeoutMs,onText:async text=>{task.progress={...task.progress,phase:'streaming',receivedChars:text.length,updatedAt:now()};if(Date.now()-lastProgress>=1000){lastProgress=Date.now();await this.persist();}},maxTokens:job.workflow?.id==='ppt'&&task.id==='developer'?12000:maxTokens,onProvider:async(provider,role)=>{
      task.modelAssignment={providerId:provider.id,name:provider.name,model:provider.model,role};
      await this.persist();
    }});
  }
  async executeTask(job,task) {
    if(task.id==='orchestrator')return this.model(job,task,planningInstruction,{brief:job.brief,kind:job.kind,team:job.configSnapshot?.agentProviders||this.state.config.agentProviders,connectedModels:this.state.config.providers.map(p=>({id:p.id,name:p.name,model:p.model})),routingExplanation:'team keys are roles, values are model connection IDs. A connected model is not automatically assigned. Report the current actual mapping; do not claim that a model name must itself be an agentId.'});
    const workspace=await this.workspace(job,task);
    const context=await readContext(workspace);const source=context.files.map(f=>({path:f.path,content:f.content}));let chars=0;const bounded=source.filter(f=>{chars+=f.content.length;return chars<38000;});
    const plan=job.tasks.find(t=>t.id==='orchestrator').result;
      const common={brief:job.brief,kind:job.kind,plan,currentAssignment:plan?.assignments?.find(a=>a.agentId===task.id),files:bounded,index:context.files.map(f=>f.path),repairFeedback:job.repairFeedback || null,contextCoverage:{read:context.files.length,provided:bounded.length,skipped:context.skipped,truncated:context.truncated||bounded.length<context.files.length}};
    if(task.id==='context') {
      await this.record(job.id,task.id,'context_read',{files:context.files.map(f=>({path:f.path,hash:f.hash})),coverage:common.contextCoverage});
      if(job.managedWorkspace&&job.workflow&&['ppt','document','project'].includes(job.workflow.id)&&source.every(file=>file.path==='README.md')){
        delete task.modelAssignment;delete task.progress;
        return {summary:'已在本地盘点用户需求、模板资料和新建工作区。当前没有已有项目源码需要模型检索；资料尚未联网核实。',source:'local_inventory',modules:source.map(file=>({path:file.path})),dependencies:[],interfaces:[],constraints:['只使用用户提供的资料，缺失的事实需标为待确认。'],missingContext:job.workflow.values.materials?[]:['未提供参考资料，产品事实和数据需要用户确认。'],coverage:common.contextCoverage};
      }
      return this.model(job,task,'Analyze actual project context. Respond {summary,modules:[],dependencies:[],interfaces:[],constraints:[],missingContext:[]}. Explicitly describe incomplete coverage; never claim all source was read.',common);
    }
    if(task.id==='architect')return this.model(job,task,'Respond {summary,modules:[],directoryStructure:[],interfaces:[],risks:[],implementationSteps:[]}. Design an achievable solution for the original requirements and current code.',common);
    if(['frontend','backend'].includes(task.id))return executeAgentWork(this,job,task,specialistInstructions(task.id),common,10000);
    if(task.id==='developer')return executeAgentWork(this,job,task,(task.coordinated?'Act as the coordinating lead: integrate specialist work and preserve their working code. ':'')+'Implement the requested work using focused file batches. Respect the architecture, preserve existing behavior and provide actual source files. No downloads or shell execution. Follow the workflow output contract when present.',{...common,architecture:job.tasks.find(t=>t.id==='architect').result,repositoryContext:job.tasks.find(t=>t.id==='context').result,specialists:job.tasks.filter(t=>['frontend','backend'].includes(t.id)).map(t=>({role:t.id,result:t.result}))},12000);
    if(task.id==='docs'){const result=await this.model(job,task,'Update documentation to match implemented changes. Respond {summary,files:[{path,content}],limitations:[]}. Files must be Markdown or plain-text docs. Do not claim tests passed. Preserve relevant existing README instructions.',{...common,development:job.tasks.find(t=>t.id==='developer').result},3500);await this.writeFiles(job,task,result.files || []);return {...result,files:(result.files||[]).map(f=>({path:f.path}))};}
    if(task.id==='tester') {
      if(job.workflow?.id==='website'){
        const checked=validateWorkflowArtifact('website',this.predecessorFiles(job,task),job.workflow.values);
        const plan=await this.model(job,task,'Inspect the actual website files. Respond {summary,steps:[{action:"click|fill|visible|text",selector,value?}],requirements:[],limitations:[]}. Supply up to 20 concrete DOM interaction checks matching the requested behavior. Do not invent results. The application executes these in an isolated browser with no network or filesystem; omit external service interactions.',common,3000);
        const report=this.browserTester?await this.browserTester(checked.artifact.html,plan.steps||[]):{status:'unverified',scope:'structure_only',checks:[],limitations:['当前运行方式没有隔离浏览器测试器；结构检查不能代替交互测试。']};
        if(report.scope==='isolated_browser_dom')checked.limitations=checked.limitations.filter(value=>!value.startsWith('未执行浏览器交互'));
        checked.browserReport=report;checked.checks.push(...report.checks);checked.limitations.push(...report.limitations);job.deliverable=checked;
        await this.record(job.id,task.id,'website_browser_checked',{status:report.status,scope:report.scope,checks:report.checks});
        return {summary:plan.summary,files:[],testReport:report};
      }
      if(job.workflow && ['ppt','document','project'].includes(job.workflow.id)){
        const files=this.predecessorFiles(job,task);
        const checked=validateWorkflowArtifact(job.workflow.id,files,job.workflow.values);
        const code=files.some(file=>/\.(?:[cm]?[jt]sx?|py|java|go|rs|cs|sh|rb|php|c|cpp|html)$/i.test(file.path));
        if(code)throw new Error('此文档工作流包含可执行源码，请使用代码工作流检查');
        job.deliverable=checked;
        await this.record(job.id,task.id,'workflow_artifact_validated',{workflowId:job.workflow.id,checks:checked.checks,limitations:checked.limitations});
        return {summary:'交付文件结构检查完成，内容仍需需求验收和人工审阅',files:[],testReport:{status:'passed',scope:'document_structure_only',checks:checked.checks,limitations:checked.limitations}};
      }
      const result=await this.model(job,task,'Create meaningful tests appropriate for the change. Respond {summary,files:[{path,content}],command:{image:"node:22-alpine",argv:["node","--test"]},reason,noExecutionNeeded:false}. Tests can only be written under tests/ or filenames ending test/spec plus extension. Commands execute in a read-only /workspace Docker mount with network disabled, no package installation. Allowed images: node:22-alpine or python:3.12-alpine, must already exist locally. argv is an array of separate strings, never shell text. For pure document deliverables noExecutionNeeded:true and command:null is permitted with justification. Do not claim execution occurred.',common,4000);
      await this.writeFiles(job,task,result.files||[]);task.result={...result,files:(result.files||[]).map(f=>({path:f.path}))};
      const hasExecutableOutput=job.artifacts.some(file=>/\.(?:[cm]?[jt]sx?|py|java|go|rs|cs|sh|rb|php|c|cpp)$/i.test(file.path));
      if(result.noExecutionNeeded && !hasExecutableOutput && !['project','website','code','review'].includes(job.kind) && !result.command){task.result.testReport={status:'not_applicable',reason:result.reason || '纯文档成果，无执行测试'};return task.result;}
      this.validateSandbox(result.command);const approval=await this.approval(job,task,'sandbox','执行自动化测试',{image:result.command.image,argv:result.command.argv,cwd:workspace,network:'none',filesystem:'read-only',dockerAvailable:this.capabilities.docker},{command:result.command,workspace});task.status='awaiting_approval';task.approvalId=approval.id;if(job.approvalMode==='auto_sandbox'&&this.capabilities.docker){approval.autoApproved=true;await this.record(job.id,'sandbox','approval_auto_decided',{id:approval.id,policy:'auto_sandbox',reason:'用户允许自动执行无网络、只读工作树的受限容器测试'});await this.decide(approval.id,true);}return task.result;
    }
    if(task.id==='regression') {
      if(job.workflow){const checked=validateWorkflowArtifact(job.workflow.id,this.predecessorFiles(job,task),job.workflow.values);if(checked.artifact){const report=job.deliverable?.browserReport;if(report){checked.browserReport=report;checked.checks.push(...report.checks);checked.limitations=[...checked.limitations.filter(value=>report.scope!=='isolated_browser_dom'||!value.startsWith('未执行浏览器交互')),...report.limitations];}job.deliverable=checked;}}
      const test=job.tasks.find(t=>t.id==='tester').result;const result=await this.model(job,task,'Independently compare implemented files with every original requirement. Respond {summary,passed:boolean,checks:[{requirementId,status:"passed|failed|partial",evidence}],missing:[],risks:[]}. passed may be true only when every requirement is satisfied and the actual supplied test report succeeds (or explicitly not applicable for pure documents). Never fabricate execution.',{...common,testReport:test?.testReport,development:job.tasks.find(t=>t.id==='developer').result});
      if(!Array.isArray(result.checks) || !result.checks.length || result.checks.some(c=>c.status!=='passed') || (result.missing||[]).length)result.passed=false;
      const requirements=Array.isArray(plan?.requirements)?plan.requirements:[];
      if(!requirements.length || requirements.some(requirement=>!result.checks?.some(check=>check.requirementId===requirement.id&&check.status==='passed')))result.passed=false;
      if(!['passed','not_applicable'].includes(test?.testReport?.status))result.passed=false;
      task.result=result;
      if(!result.passed){
        if(job.managedWorkspace&&['ppt','document','project','website'].includes(job.workflow?.id)&&test?.testReport?.status==='passed'){
          result.reviewRequired=true;job.reviewRequired=true;job.acceptanceStatus='needs_review';
          await this.record(job.id,task.id,'artifact_review_required',{checks:result.checks,missing:result.missing||[],reason:'内容初稿已完成结构检查；未满足项保留为人工审阅清单，不冒充验收通过'});
          return result;
        }
        throw new Error('acceptance_failed: 验收存在缺失或未通过项，请查看验收报告');
      }
      job.reviewRequired=false;job.acceptanceStatus='passed';return result;
    }
    if(task.id==='git') {
      const diff=await this.git(workspace,['diff','--no-ext-diff','--no-textconv','--stat']);const status=await this.git(workspace,['status','--short']);const patches=await this.git(workspace,['diff','--no-ext-diff','--no-textconv','--']);
      if(job.managedWorkspace&&['ppt','document','project','website'].includes(job.workflow?.id)){
        const result={summary:job.reviewRequired?'内容初稿已生成，验收缺项保留，等待人工审阅。':'内容初稿已生成，可以打开审阅与导出。',commitMessage:'docs: add '+job.workflow.id+' draft',prTitle:job.brief.slice(0,100),prBody:'Generated draft files for review. No commit, merge or publication was performed.',changes:job.artifacts.map(file=>file.path),risks:job.tasks.find(item=>item.id==='regression').result?.missing||[],diff:patches.slice(0,150000),status,branch:task.branch,commitStatus:'approval_required'};
        job.branch=task.branch;job.worktree=workspace;job.summary=result.summary;return result;
      }
      const result=await this.model(job,task,'Respond {summary,commitMessage,prTitle,prBody,changes:[],risks:[]}. Generate proposed Git/PR text only; do not claim a commit, merge, or PR exists.',{brief:job.brief,status,diff,files:job.artifacts.map(f=>f.path)},2200);
      job.branch=task.branch;job.worktree=workspace;job.summary=result.summary;result.diff=patches.slice(0,150000);result.status=status;result.branch=task.branch;result.commitStatus='approval_required';return result;
    }
  }
  async run(job) {
    if(job.recoveryIncomplete)throw new HttpError(409,'历史记录仅部分恢复，请查看保留成果并新建任务，不能自动继续原操作','history_read_only');
    if(this.active.has(job.id))return;const controller=new AbortController();this.active.set(job.id,controller);job.status='running';
    try {
      await this.persist();
      while(!controller.signal.aborted && job.status!=='paused') {
        if(job.repairRequested)this.prepareRepair(job);
        if(expandCoordination(job)){await this.record(job.id,'orchestrator','team_delegated',{roles:job.tasks.filter(t=>['frontend','backend'].includes(t.id)).map(t=>t.id)});await this.persist();}
        const ready=job.tasks.filter(t=>['queued','blocked'].includes(t.status)&&t.deps.every(dep=>job.tasks.find(p=>p.id===dep).status==='completed'));
        if(!ready.length)break;
        await Promise.all(ready.map(async task=>{task.status='running';task.startedAt=now();task.error=null;await this.record(job.id,task.id,'task_started',{title:task.title});await this.persist();try{task.result=await this.executeTask(job,task);if(task.status==='running')task.status='completed';task.completedAt=now();await this.record(job.id,task.id,'task_finished',{status:task.status});}catch(error){task.status=controller.signal.aborted?'interrupted':'failed';task.error=this.gateway.redact(error.message);task.errorCode=/^model_[a-z_]+$/.test(error.code||'')?error.code:null;if(error.transport)task.responseTransport=error.transport;await this.record(job.id,task.id,'task_failed',{error:task.error});}job.updatedAt=now();await this.persist();}));
      }
      if(job.status==='paused')return;
      if(job.tasks.every(t=>t.status==='completed')) {job.status='completed';if(!job.reviewRequired&&!this.state.skills.some(s=>s.sourceJobId===job.id)){const skill={id:id('skill'),name:job.tasks[0].result?.summary?.slice(0,80)||job.brief.slice(0,80),summary:JSON.stringify({requirements:job.tasks[0].result?.requirements,architecture:job.tasks.find(t=>t.id==='architect').result?.summary,acceptance:job.tasks.find(t=>t.id==='regression').result?.summary}).slice(0,6000),sourceJobId:job.id,createdAt:now()};this.state.skills.push(skill);await this.record(job.id,'orchestrator','skill_saved',{id:skill.id,name:skill.name});}}
      else if(job.tasks.some(t=>t.status==='awaiting_approval'))job.status='awaiting_approval';
      else if(job.tasks.some(t=>t.status==='failed'))job.status='failed';else job.status='interrupted';
    } catch(error) {if(job.status!=='paused')job.status='interrupted';for(const task of job.tasks)if(task.status==='running'){task.status='interrupted';task.error=this.gateway.redact(error.message);}job.error=this.gateway.redact(error.message);throw error;
    } finally {this.active.delete(job.id);job.updatedAt=now();await this.persist();}
  }
  async commitSnapshot(job,files) {
    if(!files.length)throw new HttpError(409,'没有可提交的成果文件');
    const snapshot={head:await this.git(job.worktree,['rev-parse','HEAD']),branch:await this.git(job.worktree,['symbolic-ref','--short','HEAD']),indexHash:hash(await this.git(job.worktree,['ls-files','--stage','-z'])),files:[]};
    for(const file of files){const target=await safePath(job.worktree,file,{writing:true}),stat=await fs.stat(target);if(!stat.isFile())throw new HttpError(409,'成果文件不可读取，请重新验收');snapshot.files.push({path:file,hash:hash((await fs.readFile(target)).toString('base64')),executable:!!(stat.mode&0o111)});}
    return snapshot;
  }
  prepareRepair(job) {
    job.repairRequested=false;job.repairCount=(job.repairCount||0)+1;
    for(const task of job.tasks)if(['developer','tester','docs','regression','git'].includes(task.id)){task.status='queued';task.error=null;task.errorCode=null;delete task.approvalId;if(task.workCheckpoint){task.previousCheckpoint=task.workCheckpoint;delete task.workCheckpoint;}}
    job.status='running';
  }
  validateSandbox(command) { if(!command || !['node:22-alpine','python:3.12-alpine'].includes(command.image)||!Array.isArray(command.argv)||!command.argv.length||command.argv.length>30||command.argv.some(s=>typeof s!=='string'||s.length>4000||s.includes('\0')))throw new Error('测试命令须包含允许的已安装镜像和有效 argv 数组');if(!['node','npm','npx','python','python3','pytest'].includes(command.argv[0]))throw new Error('沙盒仅支持 Node/Python 测试入口');if(command.argv[0]==='npx'||(command.argv[0]==='npm'&&['install','i','ci','exec'].includes(command.argv[1])))throw new Error('不允许测试阶段下载依赖'); }
  sandboxArgs(workspace,command,containerName) { return ['run','--name',containerName,'--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--user','1000:1000','--mount',`type=bind,source=${workspace},target=/workspace,readonly`,'--tmpfs','/tmp:rw,noexec,nosuid,size=67108864','--env','HOME=/tmp','--env','NPM_CONFIG_CACHE=/tmp/npm','--workdir','/workspace',command.image,...command.argv]; }
  async approval(job,task,type,title,details,action) {
    const approvalId=id('approval');const commands=[];let risk='';
    if(type==='sandbox'){commands.push({command:'docker',args:this.sandboxArgs(action.workspace,action.command,`reviewfm-${approvalId}`),cwd:action.workspace});risk='执行模型建议的测试代码。容器无网络、工作树只读，限制内存/CPU/进程数；镜像须预先存在，测试失败可能触发开发修复，但新测试仍需重新审批。';}
    if(type==='commit'){commands.push({command:'git',args:['--literal-pathspecs','add','--',...details.files],cwd:job.worktree},{command:'git',args:['--literal-pathspecs','commit','--only','-m',action.message,'--',...details.files],cwd:job.worktree});risk='只提交审批清单内的成果文件；提交前核对文件、分支和暂存区是否变化。不会推送远端。';}
    if(type==='merge'){commands.push({command:'git',args:['merge','--no-ff','--no-edit',action.sourceCommit],cwd:job.projectPath});risk='会更新项目当前分支与工作目录。目录必须干净、审批时分支/HEAD 不变；冲突时尝试中止合并并交由你确认。不会推送远端。';}
    if(type==='rollback'){commands.push({command:'git',args:['revert','--no-edit',...(action.mainline?['-m',String(action.mainline)]:[]),action.commit],cwd:action.cwd});risk='创建新 revert 提交撤销本任务拥有的提交；不删除历史。工作区需干净且 HEAD 与审批时一致。';}
    const reviewedDetails={...details,commands,risk};const item={id:approvalId,jobId:job.id,taskId:task?.id||'git',type,title,status:'pending',details:reviewedDetails,action,createdAt:now()};this.state.approvals.push(item);await this.record(job.id,task?.id||'git','approval_requested',{id:item.id,type,title,details:reviewedDetails});await this.persist();return item;
  }
  async actions(job,action) {
    if(job.recoveryIncomplete)throw new HttpError(409,'历史记录仅部分恢复，当前只供查看和导出。请新建任务继续工作。','history_read_only');
    if(action==='pause'){job.status='paused';this.active.get(job.id)?.abort();await this.record(job.id,'orchestrator','job_paused');await this.persist();return {job};}
    if(['resume','retry'].includes(action)) {
      if(this.active.has(job.id))throw new HttpError(409,'任务仍在运行或正在暂停');
      if(this.state.approvals.some(a=>a.jobId===job.id&&['unknown','running'].includes(a.status)))throw new HttpError(409,'有执行结果未知的动作，请先核对工作树；系统不会自动重新执行');
      const reviewTask=job.tasks.find(task=>task.id==='regression');
      if(job.managedWorkspace&&['ppt','document','project','website'].includes(job.workflow?.id)&&job.deliverable?.artifact&&job.tasks.some(task=>task.id==='tester'&&task.status==='completed')&&reviewTask?.status==='failed'&&reviewTask.result?.passed===false&&/^acceptance_failed:/.test(reviewTask.error||'')){
        reviewTask.previousError=reviewTask.error;reviewTask.error=null;reviewTask.errorCode=null;reviewTask.status='completed';reviewTask.result.reviewRequired=true;job.reviewRequired=true;job.acceptanceStatus='needs_review';
        await this.record(job.id,'regression','artifact_review_required',{missing:reviewTask.result.missing||[],reason:'继续已有内容初稿，保留未通过的验收结果并交给人工审阅；不重复调用已完成制作阶段'});
      }
      for(const task of job.tasks)if(['failed','interrupted'].includes(task.status)){task.status='queued';task.error=null;task.errorCode=null;}
      if(job.repairFeedback && (job.repairCount||0)<2)this.prepareRepair(job);
      if(!job.tasks.some(t=>['queued','blocked'].includes(t.status)))throw new HttpError(409,'没有可继续的阶段');
      job.status='queued';await this.record(job.id,'orchestrator','job_resumed',{action});await this.persist();this.run(job).catch(()=>{});return {job};
    }
    if(!['commit','merge','rollback'].includes(action))throw new HttpError(400,'不支持的任务操作');
    if(this.state.approvals.some(a=>a.jobId===job.id&&a.type===action&&['pending','running','unknown'].includes(a.status)))throw new HttpError(409,'该操作已有待处理审批');
    const gitTask=job.tasks.find(t=>t.id==='git');if(!job.worktree||gitTask.status!=='completed')throw new HttpError(409,'请先完成开发、测试与回归验收');
    if(action==='commit'){if(job.commit)throw new HttpError(409,'任务已有提交');const message=String(gitTask.result.commitMessage || `Complete task ${job.id}`).slice(0,500),files=[...new Set(job.artifacts.map(f=>f.path))].sort(),snapshot=await this.commitSnapshot(job,files);return {job,approval:await this.approval(job,gitTask,'commit','提交此任务工作树变更',{worktree:job.worktree,branch:job.branch,message,files},{message,snapshot})};}
    if(action==='merge'){if(!job.commit)throw new HttpError(409,'请先审批生成任务提交');if(job.mergedCommit)throw new HttpError(409,'此任务已合并');const targetHead=await this.git(job.projectPath,['rev-parse','HEAD']);const targetBranch=await this.git(job.projectPath,['symbolic-ref','--short','HEAD']).catch(()=>{throw new HttpError(409,'目标仓库需位于命名分支');});return {job,approval:await this.approval(job,gitTask,'merge','合并已验收任务到项目当前分支',{projectPath:job.projectPath,sourceBranch:job.branch,sourceCommit:job.commit,targetBranch,targetHead},{targetHead,targetBranch,sourceCommit:job.commit})};}
    if(!job.commit)throw new HttpError(409,'只支持回滚此系统已创建的提交，请先生成任务提交');const cwd=job.mergedCommit?job.projectPath:job.worktree,commit=job.mergedCommit||job.commit;const head=await this.git(cwd,['rev-parse','HEAD']);return {job,approval:await this.approval(job,gitTask,'rollback','以新 revert 提交回滚本任务',{cwd,commit,head,mainline:job.mergedCommit?1:null},{cwd,commit,head,mainline:job.mergedCommit?1:null})};
  }
  async decide(approvalId,approved) {
    if(typeof approved!=='boolean')throw new HttpError(400,'approved 必须为布尔值');const approval=this.state.approvals.find(a=>a.id===approvalId);if(!approval)throw new HttpError(404,'审批不存在');if(approval.status!=='pending')throw new HttpError(409,'审批已处理，不可重复执行');
    const job=this.job(approval.jobId);if(job.recoveryIncomplete)throw new HttpError(409,'恢复的历史审批只供查看，不能重新执行','history_read_only');const task=job.tasks.find(t=>t.id===approval.taskId),previousDecision=approval.decidedAt;approval.status=approved?'running':'rejected';approval.decidedAt=now();try{await this.record(job.id,'sandbox','approval_decided',{id:approval.id,type:approval.type,approved});await this.persist();}catch(error){approval.status='pending';if(previousDecision===undefined)delete approval.decidedAt;else approval.decidedAt=previousDecision;await this.persist().catch(()=>{});throw error;}
    if(!approved){if(approval.type==='sandbox'){task.status='failed';task.error='用户拒绝测试命令';job.status='failed';}await this.persist();return {approval,job};}
    try {
      if(approval.type==='sandbox') {
        const {command,workspace}=approval.action;this.validateSandbox(command);if(!isWithin(path.join(this.runtime,'worktrees',job.id),workspace))throw new Error('沙盒工作目录不属于此任务');
        if(!this.capabilities.docker){this.capabilities.docker=(await runCommand('docker',['info','--format','{{.ServerVersion}}'],{timeout:5000}).catch(()=>({code:1}))).code===0;if(!this.capabilities.docker)throw new Error('docker_required: Docker 不可用；未执行任何主机测试命令');}
        const image=await runCommand('docker',['image','inspect',command.image],{timeout:5000});if(image.code!==0)throw new Error(`镜像 ${command.image} 尚未安装，请自行拉取后重试；服务不自动下载镜像`);
        const containerName=`reviewfm-${approval.id}`;
        const args=this.sandboxArgs(workspace,command,containerName);
        await this.record(job.id,'sandbox','command_started',{approvalId:approval.id,command:'docker',args});const result=await runCommand('docker',args,{timeout:120000});
        if(result.timedOut || result.outputTruncated){const cleanup=await runCommand('docker',['rm','--force',containerName],{timeout:10000});await this.record(job.id,'sandbox','container_cleanup',{containerName,code:cleanup.code});}
        result.stdout=this.gateway.redact(result.stdout);result.stderr=this.gateway.redact(result.stderr);approval.result=result;task.result.testReport={status:result.code===0&&!result.timedOut&&!result.outputTruncated?'passed':'failed',...result,image:command.image,argv:command.argv,executedAt:now()};await this.record(job.id,'sandbox','command_finished',{approvalId:approval.id,...task.result.testReport});if(task.result.testReport.status!=='passed')throw new Error('自动化测试未通过，请查看真实测试报告');task.status='completed';task.completedAt=now();
      } else if(approval.type==='commit') {
        if(job.commit)throw new Error('任务已有提交');const approved=approval.action.snapshot;if(!approved?.files?.length)throw new Error('这条旧审批没有文件校验记录，请重新创建提交审批');const files=approved.files.map(file=>file.path),currentFiles=[...new Set(job.artifacts.map(file=>file.path))].sort();if(JSON.stringify(files)!==JSON.stringify(currentFiles)||hash(await this.commitSnapshot(job,files))!==hash(approved))throw new Error('审批后文件、分支或暂存区已变化，请查看变更并重新创建提交审批');await this.git(job.worktree,['--literal-pathspecs','add','--',...files],job.id,'git',true);const staged=await this.commitSnapshot(job,files);if(staged.head!==approved.head||staged.branch!==approved.branch||hash(staged.files)!==hash(approved.files))throw new Error('提交前成果内容发生变化，已停止提交，请重新审阅');await this.git(job.worktree,['--literal-pathspecs','commit','--only','-m',approval.action.message,'--',...files],job.id,'git',true);job.commit=await this.git(job.worktree,['rev-parse','HEAD']);approval.result={commit:job.commit,branch:job.branch};
      } else if(approval.type==='merge') {
        if((await this.git(job.projectPath,['status','--porcelain'])).trim())throw new Error('目标项目存在未提交改动，合并已停止');const head=await this.git(job.projectPath,['rev-parse','HEAD']);const branch=await this.git(job.projectPath,['symbolic-ref','--short','HEAD']);if(head!==approval.action.targetHead||branch!==approval.action.targetBranch)throw new Error('审批后目标分支已变化，请重新创建合并审批');const source=await this.git(job.worktree,['rev-parse','HEAD']);if(source!==approval.action.sourceCommit)throw new Error('审批后来源分支已变化');
        try{await this.git(job.projectPath,['merge','--no-ff','--no-edit',approval.action.sourceCommit],job.id,'git',true);}catch(error){const conflicts=await this.git(job.projectPath,['diff','--name-only','--diff-filter=U']);await this.git(job.projectPath,['merge','--abort'],job.id,'git',true).catch(()=>{});throw new Error(`合并失败，已尝试中止自动合并；冲突需人工确认：${conflicts || error.message}`);}job.mergedCommit=await this.git(job.projectPath,['rev-parse','HEAD']);approval.result={mergeCommit:job.mergedCommit,targetBranch:branch};
      } else if(approval.type==='rollback') {
        const {cwd,commit,head,mainline}=approval.action;if(commit!==job.commit&&commit!==job.mergedCommit)throw new Error('仅能回滚本任务拥有的提交');if(await this.git(cwd,['rev-parse','HEAD'])!==head)throw new Error('审批后 HEAD 已变化，请重新创建回滚审批');if(await this.git(cwd,['status','--porcelain']))throw new Error('工作区有未提交变更，无法回滚');try{await this.git(cwd,['revert','--no-edit',...(mainline?['-m',String(mainline)]:[]),commit],job.id,'git',true);}catch(error){await this.git(cwd,['revert','--abort'],job.id,'git',true).catch(()=>{});throw new Error(`回滚冲突，需人工确认：${error.message}`);}approval.result={revertCommit:await this.git(cwd,['rev-parse','HEAD']),reverted:commit};job.rollbackCommit=approval.result.revertCommit;
      }
      approval.status='approved';await this.record(job.id,approval.type==='sandbox'?'sandbox':'git','approved_action_completed',{id:approval.id,type:approval.type,result:approval.result});
    }catch(error){approval.status='failed';approval.result={...(approval.result||{}),error:this.gateway.redact(error.message)};if(approval.type==='sandbox'){task.status='failed';task.error=approval.result.error;job.status='failed';if(task.result?.testReport?.status==='failed'&&(job.repairCount||0)<2){job.repairFeedback={testReport:task.result.testReport,files:task.files,attempt:(job.repairCount||0)+1};job.repairRequested=true;await this.record(job.id,'tester','repair_requested',{attempt:job.repairFeedback.attempt,reason:'真实测试失败，反馈给开发 Agent；修复后的测试仍需新审批'});}}await this.record(job.id,'sandbox','approved_action_failed',{id:approval.id,error:approval.result.error});}
    await this.persist();if(approval.type==='sandbox'&&(approval.status==='approved'||job.repairRequested)&&job.status!=='paused')this.run(job).catch(()=>{});return {approval,job};
  }
}
