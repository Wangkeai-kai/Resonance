import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../lib/engine.mjs';
import { safePath,readContext,runCommand,validateProvider } from '../lib/safety.mjs';
import { PRESETS,chooseModel,inferKind } from '../lib/providers.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=path.join(here,`backend-fixture-${Date.now()}`);const repository=path.join(fixture,'project');
await fs.mkdir(repository,{recursive:true});
const git=async args=>{const result=await runCommand('git',args,{cwd:repository});assert.equal(result.code,0,result.stderr);return result.stdout.trim();};
await git(['init']);await git(['config','user.name','Review FM Test']);await git(['config','user.email','test@example.invalid']);
await fs.writeFile(path.join(repository,'README.md'),'# Example\n');await git(['add','README.md']);await git(['commit','-m','initial']);
await fs.writeFile(path.join(repository,'.env'),'NEVER_SEND_THIS=secret');await fs.writeFile(path.join(repository,'credentials.json'),'{"token":"hidden"}');
const read=await readContext(repository);assert.equal(read.files.length,1);assert.equal(read.files[0].path,'README.md');
for(const bad of ['../outside','a/../../b','.git/config','.env','secrets.json','a/credentials.json','C:/windows/a','src\\..\\b','src/../x','NUL','con.txt','.git /config','.ENV.','folder./x','a:stream'])await assert.rejects(()=>safePath(repository,bad,{writing:true}));
await fs.link(path.join(repository,'README.md'),path.join(repository,'linked.md'));await assert.rejects(()=>safePath(repository,'linked.md',{writing:true}),/Hard-linked/);await fs.unlink(path.join(repository,'linked.md'));
assert.throws(()=>validateProvider({id:'bad',model:'test',baseUrl:'http://remote.invalid/v1'}));
assert.throws(()=>validateProvider({id:'bad',model:'test',baseUrl:'https://user:pass@example.invalid/v1'}));
const calls=[];let codeJob=false;
const mock=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};calls.push({path:req.url,body,key:req.headers['x-api-key'],authorization:req.headers.authorization});
  if(req.headers.authorization==='Bearer rejected-secret'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"rejected-secret is invalid"}');return;}
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'text-embedding-test'},{id:'deepseek-reasoner'},{id:'gpt-4.1-mini'},{id:'local-chat'}]}));return;}
  const system=body.system || body.messages.find(m=>m.role==='system')?.content || '';
  const agent=system.match(/You are the (\w+) agent/)?.[1];let result;
  if(!agent) result='OK';
  else if(agent==='orchestrator')result={summary:'Document workflow',requirements:JSON.stringify(body).includes('TEST_INVALID_REQUIREMENTS')?[]:[{id:'r1',text:'Write plan',acceptance:'A concise note exists'}],scope:{included:['Write a work plan'],excluded:['No external publishing']},questions:['Who will read the plan?'],assignments:[{agentId:'developer',objective:'Write note.md'}],risks:[],deliverables:['note.md']};
  else if(agent==='context')result={summary:'One README',modules:[],dependencies:[],interfaces:[],constraints:[],missingContext:[]};
  else if(agent==='architect')result={summary:'One deliverable',modules:[],directoryStructure:['note.md'],interfaces:[],risks:[],implementationSteps:['write note']};
  else if(agent==='developer')result={summary:'Implemented note',files:[{path:'note.md',content:'# Work plan\nA real generated artifact.\n'}],notes:[],risks:[]};
  else if(agent==='tester')result={summary:'Check deliverable',files:[],command:codeJob?{image:'node:22-alpine',argv:['node','--test']}:null,noExecutionNeeded:!codeJob,reason:'Document-only task'};
  else if(agent==='docs')result={summary:'Updated documentation',files:[{path:'README.md',content:'# Example\nSee note.md.\n'}],limitations:[]};
  else if(agent==='regression')result={summary:'Requirements present',passed:true,checks:[{requirementId:'r1',status:'passed',evidence:'note.md exists'}],missing:[],risks:[]};
  else if(agent==='git')result={summary:'Ready for review',commitMessage:'docs: add work plan',prTitle:'Add work plan',prBody:'Adds note and documentation.',changes:['note.md','README.md'],risks:[]};
  const text=typeof result==='string'?result:JSON.stringify(result);res.setHeader('Content-Type','application/json');if(req.url==='/v1/messages')res.end(JSON.stringify({content:[{type:'text',text}],usage:{input_tokens:100,output_tokens:100}}));else res.end(JSON.stringify({choices:[{message:{content:text}}],usage:{prompt_tokens:100,completion_tokens:100}}));
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${mock.address().port}`;
const engine=await new Engine(path.join(fixture,'app')).init();
await assert.rejects(()=>engine.create({brief:'write a plan'}),e=>e.code==='configuration_required');
await engine.config({projectPath:repository,providers:[{id:'local',name:'Local test',type:'openai',baseUrl:`${endpoint}/v1`,model:'test-model',apiKey:'private-test-key'},{id:'claude',name:'Claude mock',type:'anthropic',baseUrl:endpoint,model:'test-claude',apiKey:'private-anthropic-key'}],agentProviders:{architect:'claude'}});
assert.equal(engine.publicConfig().providers[0].hasKey,true);assert.ok(!JSON.stringify(engine.status()).includes('private-test-key'));
await engine.config({providers:[{id:'local',name:'Local test',type:'openai',baseUrl:`${endpoint}/v1`,model:'test-model'},{id:'claude',name:'Claude mock',type:'anthropic',baseUrl:endpoint,model:'test-claude'}]});assert.equal(engine.publicConfig().providers[0].hasKey,true);
assert.equal((await engine.gateway.test('claude')).ok,true);assert.equal(calls.at(-1).path,'/v1/messages');assert.equal(calls.at(-1).key,'private-anthropic-key');
const until=async condition=>{const start=Date.now();while(!condition()){if(Date.now()-start>30000)throw new Error(`Timed out: ${JSON.stringify(engine.state.jobs[0])}`);await new Promise(resolve=>setTimeout(resolve,30));}};
const job=await engine.create({brief:'Write a useful document and update its README',kind:'work',useProject:true,budget:100000});await until(()=>!engine.active.has(job.id));
assert.equal(job.status,'completed',JSON.stringify(job.tasks));assert.equal(job.tasks.length,8);assert.equal(new Set(job.tasks.map(t=>t.worktree).filter(Boolean)).size,7);assert.equal(engine.state.skills.length,1);assert.equal(await fs.readFile(path.join(job.worktree,'note.md'),'utf8'),'# Work plan\nA real generated artifact.\n');assert.equal(await fs.readFile(path.join(repository,'README.md'),'utf8'),'# Example\n');
assert.equal(await fs.readFile(path.join(job.worktree,'README.md'),'utf8'),'# Example\nSee note.md.\n');const completedJSON=JSON.stringify(job);const completedCalls=calls.length;await assert.rejects(()=>engine.actions(job,'resume'),e=>e.status===409);assert.equal(JSON.stringify(job),completedJSON);assert.equal(calls.length,completedCalls);
assert.ok(calls.some(c=>c.path==='/v1/messages'&&c.body.system.includes('architect')));assert.ok(calls.every(c=>!JSON.stringify(c.body).includes('NEVER_SEND_THIS')));
const pendingCommit=await engine.actions(job,'commit');assert.equal(pendingCommit.approval.status,'pending');assert.equal(job.commit,undefined);await engine.decide(pendingCommit.approval.id,true);assert.ok(job.commit,pendingCommit.approval.result?.error);await assert.rejects(()=>engine.decide(pendingCommit.approval.id,true),e=>e.status===409);
// Untracked secrets are intentionally present: dirty main workspace must block merge.
const blockedMerge=await engine.actions(job,'merge');await engine.decide(blockedMerge.approval.id,true);assert.equal(blockedMerge.approval.status,'failed');assert.match(blockedMerge.approval.result.error,/未提交改动/);
await fs.writeFile(path.join(repository,'.gitignore'),'.env\ncredentials.json\n');await git(['add','.gitignore']);await git(['commit','-m','ignore local credentials']);
const pendingMerge=await engine.actions(job,'merge');await engine.decide(pendingMerge.approval.id,true);assert.equal(pendingMerge.approval.status,'approved',JSON.stringify(pendingMerge.approval.result));assert.ok(job.mergedCommit);assert.ok((await fs.readFile(path.join(repository,'note.md'),'utf8')).includes('real generated'));
const rollback=await engine.actions(job,'rollback');await engine.decide(rollback.approval.id,true);assert.equal(rollback.approval.status,'approved',JSON.stringify(rollback.approval.result));await assert.rejects(()=>fs.readFile(path.join(repository,'note.md')));
codeJob=true;const job2=await engine.create({brief:'Create a Node project with tests',kind:'project',budget:100000});await until(()=>!engine.active.has(job2.id));assert.equal(job2.status,'awaiting_approval');const testApproval=engine.state.approvals.find(a=>a.jobId===job2.id&&a.type==='sandbox');assert.ok(testApproval);assert.ok(job2.tasks.find(t=>t.id==='regression').status==='blocked');await engine.decide(testApproval.id,false);assert.equal(job2.status,'failed');assert.equal(job2.tasks.find(t=>t.id==='tester').error,'用户拒绝测试命令');
await engine.actions(job2,'retry');await until(()=>!engine.active.has(job2.id));assert.equal(job2.status,'awaiting_approval');assert.equal(engine.state.approvals.filter(a=>a.jobId===job2.id&&a.type==='sandbox').length,2);
job2.status='running';job2.tasks.find(t=>t.id==='tester').status='running';const unresolved=engine.state.approvals.find(a=>a.jobId===job2.id&&a.status==='pending');unresolved.status='running';await engine.persist();
const recovered=await new Engine(path.join(fixture,'app')).init();assert.equal(recovered.job(job2.id).status,'interrupted');assert.equal(recovered.job(job2.id).tasks.find(t=>t.id==='tester').status,'interrupted');assert.equal(recovered.state.approvals.find(a=>a.id===unresolved.id).status,'unknown');assert.equal(recovered.publicConfig().providers[0].hasKey,false);await assert.rejects(()=>recovered.actions(recovered.job(job2.id),'resume'),e=>e.status===409);
const disk=await fs.readFile(path.join(fixture,'app','.runtime','state.json'),'utf8');const audit=await fs.readFile(path.join(fixture,'app','.runtime','audit.jsonl'),'utf8');assert.ok(!disk.includes('private-test-key')&&!audit.includes('private-test-key'));assert.ok(!disk.includes('private-anthropic-key')&&!audit.includes('private-anthropic-key'));assert.ok(engine.audit.some(a=>a.action==='file_written'));assert.ok(engine.audit.some(a=>a.action==='git_command'));
const conflict={id:`job-conflict-${Date.now()}`,projectPath:repository,baseCommit:await git(['rev-parse','HEAD']),tasks:[{id:'context',status:'completed',deps:[],files:[{path:'parallel.md',content:'first'}]},{id:'architect',status:'completed',deps:[],files:[{path:'parallel.md',content:'second'}]},{id:'developer',deps:['context','architect'],status:'running'}]};const conflictTask=conflict.tasks[2];await assert.rejects(()=>engine.workspace(conflict,conflictTask),/parallel_file_conflict/);await assert.rejects(()=>engine.workspace(conflict,conflictTask),/parallel_file_conflict/);assert.ok(!await fs.access(path.join(conflictTask.worktree,'parallel.md')).then(()=>true,()=>false));
await engine.config({providers:[{id:'local',name:'Changed host',type:'openai',baseUrl:`${endpoint}/other-path`,model:'test-model'}]});assert.equal(engine.publicConfig().providers[0].hasKey,false);
// Quick connect is transactional and never writes candidate API keys to state or audit.
assert.equal(PRESETS.length,11);assert.equal(chooseModel([{id:'text-embedding-x'},{id:'deepseek-reasoner'},{id:'local-chat'}]),'local-chat');
assert.equal(inferKind('制作产品介绍 PPT'),'ppt');assert.equal(inferKind('创建一个餐厅网站'),'website');assert.equal(inferKind('修复已有代码中的 bug'),'code');assert.equal(inferKind('整理下周工作计划'),'work');
const quick=await new Engine(path.join(fixture,'quick-app')).init();
const connected=await quick.connect({presetId:'openai',baseUrl:`${endpoint}/v1`,apiKey:'quick-private-key'});
assert.equal(connected.provider.model,'gpt-4.1-mini');assert.equal(connected.test.ok,true);assert.equal(Object.keys(connected.config.agentProviders).length,9);
assert.ok(calls.some(c=>c.path==='/v1/models'&&c.authorization==='Bearer quick-private-key'));
const beforeFailed=JSON.stringify(quick.state.config);const diskBeforeFailed=await fs.readFile(path.join(quick.runtime,'state.json'),'utf8');
await assert.rejects(()=>quick.connect({presetId:'openai',baseUrl:`${endpoint}/v1`,apiKey:'rejected-secret',model:'gpt-4.1-mini'}),e=>e.code==='connection_failed'&&!e.message.includes('rejected-secret'));
assert.equal(JSON.stringify(quick.state.config),beforeFailed);assert.equal(quick.keys.get('openai'),'quick-private-key');assert.equal(await fs.readFile(path.join(quick.runtime,'state.json'),'utf8'),diskBeforeFailed);
await quick.connect({presetId:'openai',baseUrl:`${endpoint}/v1`,apiKey:'quick-replacement-key',model:'local-chat'});assert.equal(quick.state.config.providers.length,1);assert.equal(quick.keys.get('openai'),'quick-replacement-key');
const changedStart=calls.length;await quick.connect({presetId:'openai',baseUrl:`${endpoint}/different/v1`,model:'local-chat'});assert.ok(calls.slice(changedStart).every(c=>!c.authorization));assert.equal(quick.keys.has('openai'),false);
await assert.rejects(()=>quick.connect({presetId:'openai',baseUrl:'https://example.invalid/v1',model:'chat'}),/重新填写/);
await quick.config({providers:[{id:'old',name:'Missing old key',type:'openai',baseUrl:'https://example.invalid/v1',model:'chat'}],agentProviders:{orchestrator:'old'}});
await quick.connect({presetId:'ollama',baseUrl:`${endpoint}/v1`});assert.equal(quick.state.config.agentProviders.orchestrator,'ollama');
const quickDisk=await fs.readFile(path.join(quick.runtime,'state.json'),'utf8'),quickAudit=await fs.readFile(path.join(quick.runtime,'audit.jsonl'),'utf8');assert.ok(!/quick-private-key|quick-replacement-key|rejected-secret/.test(quickDisk+quickAudit));
// Connection identity is independent of the provider preset: same service,
// different models and keys can be added together without overwriting a row.
const multiple=await new Engine(path.join(fixture,'multiple-app')).init();
const multiBase={presetId:'openai',baseUrl:`${endpoint}/v1`};
const multiResults=await Promise.all([
  multiple.connect({...multiBase,connectionId:'openai-one',model:'gpt-4.1-mini',apiKey:'multi-first-secret'}),
  multiple.connect({...multiBase,connectionId:'openai-two',model:'local-chat',apiKey:'multi-second-secret',name:'写作模型'}),
]);
assert.deepEqual(multiResults.map(r=>r.connectionId),['openai-one','openai-two']);
assert.deepEqual(multiple.state.config.providers.map(p=>[p.id,p.model]),[['openai-one','gpt-4.1-mini'],['openai-two','local-chat']]);
assert.equal(multiple.state.config.providers[0].name,'OpenAI · GPT · gpt-4.1-mini');assert.equal(multiple.state.config.providers[1].name,'写作模型');
assert.equal(multiple.keys.get('openai-one'),'multi-first-secret');assert.equal(multiple.keys.get('openai-two'),'multi-second-secret');
assert.equal(multiple.state.config.agentProviders.orchestrator,'openai-one');
const secondBefore=JSON.stringify(multiple.state.config.providers[1]);
await multiple.connect({...multiBase,connectionId:'openai-one',model:'updated-chat'});
assert.equal(multiple.state.config.providers.length,2);assert.equal(multiple.state.config.providers[0].model,'updated-chat');assert.equal(JSON.stringify(multiple.state.config.providers[1]),secondBefore);assert.equal(calls.at(-1).authorization,'Bearer multi-first-secret');
const multipleBefore=JSON.stringify(multiple.state.config),multipleDiskBefore=await fs.readFile(path.join(multiple.runtime,'state.json'),'utf8');
await assert.rejects(()=>multiple.connect({...multiBase,connectionId:'openai-two',model:'broken-chat',apiKey:'rejected-secret'}),e=>e.code==='connection_failed'&&!e.message.includes('rejected-secret'));
await assert.rejects(()=>multiple.connect({...multiBase,connectionId:'failed-new',model:'broken-chat',apiKey:'rejected-secret'}),e=>e.code==='connection_failed');
assert.equal(JSON.stringify(multiple.state.config),multipleBefore);assert.equal(await fs.readFile(path.join(multiple.runtime,'state.json'),'utf8'),multipleDiskBefore);assert.equal(multiple.keys.get('openai-two'),'multi-second-secret');assert.equal(multiple.keys.has('failed-new'),false);
const invalidStart=calls.length;
for(const connectionId of ['', '../escape', 'x'.repeat(65), 123, null])await assert.rejects(()=>multiple.connect({...multiBase,connectionId,model:'local-chat'}),e=>e.status===400);
assert.equal(calls.length,invalidStart);
// Endpoint and protocol changes may use a new credential, never the old key.
await multiple.connect({...multiBase,connectionId:'openai-two',baseUrl:`${endpoint}/changed/v1`,model:'local-chat'});assert.equal(calls.at(-1).authorization,undefined);assert.equal(multiple.keys.has('openai-two'),false);
await multiple.connect({...multiBase,connectionId:'openai-two',model:'local-chat',apiKey:'multi-protocol-secret'});
await multiple.connect({...multiBase,presetId:'anthropic',connectionId:'openai-two',model:'test-claude'});assert.equal(calls.at(-1).key,undefined);assert.equal(calls.at(-1).authorization,undefined);assert.equal(multiple.keys.has('openai-two'),false);
// A queued config change preserves the connection added before it.
await Promise.all([multiple.connect({...multiBase,connectionId:'openai-three',model:'local-chat'}),multiple.config({projectPath:repository})]);
assert.equal(multiple.state.config.providers.length,3);assert.equal(multiple.state.config.projectPath,repository);
const multiDisk=await fs.readFile(path.join(multiple.runtime,'state.json'),'utf8'),multiAudit=await fs.readFile(path.join(multiple.runtime,'audit.jsonl'),'utf8');assert.ok(!/multi-first-secret|multi-second-secret|multi-protocol-secret|rejected-secret/.test(multiDisk+multiAudit));assert.ok(!/multi-first-secret|multi-second-secret/.test(JSON.stringify(multiple.status())));
// Reserve the final slot through the same serialized path as settings changes.
const capacity=await new Engine(path.join(fixture,'capacity-app')).init();
await capacity.config({providers:Array.from({length:11},(_,i)=>({id:`existing-${i}`,name:`Existing ${i}`,type:'openai',baseUrl:`${endpoint}/v1`,model:'local-chat'}))});
const beforeCapacity=calls.length;
const capacityResults=await Promise.allSettled([capacity.connect({...multiBase,connectionId:'last-slot',model:'local-chat'}),capacity.connect({...multiBase,connectionId:'over-limit',model:'local-chat'})]);
assert.equal(capacityResults[0].status,'fulfilled');assert.equal(capacityResults[1].status,'rejected');assert.equal(capacityResults[1].reason.code,'connection_limit');assert.equal(capacity.state.config.providers.length,12);assert.equal(calls.length-beforeCapacity,1);
await capacity.connect({...multiBase,connectionId:'last-slot',model:'updated-chat'});assert.equal(capacity.state.config.providers.length,12);assert.equal(capacity.state.config.providers.at(-1).model,'updated-chat');
// Daily work starts without a path; existing-code modification still requires one.
await assert.rejects(()=>quick.create({brief:'修复已有代码中的 bug',kind:'auto'}),e=>e.code==='project_required');
codeJob=false;const managed=await quick.create({brief:'整理下周工作计划',kind:'auto'});await until(()=>!quick.active.has(managed.id));assert.equal(managed.status,'completed',JSON.stringify(managed.tasks));assert.equal(managed.kind,'work');assert.equal(managed.managedWorkspace,true);assert.equal(managed.projectPath,path.join(quick.runtime,'projects',managed.id));assert.equal(quick.state.config.projectPath,'');
assert.equal(await quick.git(managed.projectPath,['config','--local','user.name']),'Gongming Workspace');assert.equal(await git(['config','--local','user.name']),'Review FM Test');
const managedCommit=await quick.actions(managed,'commit');await quick.decide(managedCommit.approval.id,true);assert.equal(managedCommit.approval.status,'approved',JSON.stringify(managedCommit.approval.result));
// Optional requirements analysis has no Git dependency or workspace side effects.
const planning=await new Engine(path.join(fixture,'planning-app')).init();
await assert.rejects(()=>planning.analyze({brief:'Plan a useful document'}),e=>e.code==='configuration_required');
await planning.config({providers:[{id:'planner',name:'Planning mock',type:'openai',baseUrl:`${endpoint}/v1`,model:'local-chat',apiKey:'planning-private-key'}]});planning.capabilities.git=false;
const analysis=await planning.analyze({brief:'Plan a useful document',kind:'auto',budget:100000});assert.equal(analysis.kind,'work');assert.equal(analysis.result.requirements.length,1);assert.equal(analysis.result.scope.included.length,1);assert.equal(analysis.result.questions.length,1);assert.equal(analysis.tokens.input,100);assert.equal(analysis.tokens.output,100);assert.ok(analysis.tokens.reserved>0);assert.equal(planning.state.jobs.length,0);assert.equal(planning.state.analyses.length,1);assert.equal(planning.status().analyses[0].id,analysis.id);assert.ok(!planning.audit.some(a=>a.action==='git_command'));assert.ok(!await fs.access(path.join(planning.runtime,'projects')).then(()=>true,()=>false));assert.deepEqual(await fs.readdir(path.join(planning.runtime,'worktrees')),[]);
const plannedDisk=await fs.readFile(path.join(planning.runtime,'state.json'),'utf8'),plannedAudit=await fs.readFile(path.join(planning.runtime,'audit.jsonl'),'utf8');assert.ok(!(plannedDisk+plannedAudit).includes('planning-private-key'));assert.ok(planning.audit.some(a=>a.jobId===analysis.id&&a.action==='requirements_analysis_completed'));
planning.capabilities.git=true;
await assert.rejects(()=>planning.create({brief:'The changed brief',kind:'auto',analysisId:analysis.id}),e=>e.code==='analysis_stale');
await assert.rejects(()=>planning.create({brief:analysis.brief,kind:'ppt',analysisId:analysis.id}),e=>e.code==='analysis_stale');
await assert.rejects(()=>planning.create({brief:analysis.brief,kind:'auto',analysisId:'analysis-missing'}),e=>e.code==='analysis_not_found');
await assert.rejects(()=>planning.create({brief:analysis.brief,kind:'auto',analysisId:analysis.id,budget:2000}),e=>e.code==='token_budget_exceeded');
const orchestratorCalls=()=>calls.filter(c=>/You are the orchestrator agent/.test(c.body.system||c.body.messages?.find(m=>m.role==='system')?.content||'')).length;
const beforeReuse=orchestratorCalls(),savedTokens={...analysis.tokens};const plannedJob=await planning.create({brief:analysis.brief,kind:'auto',analysisId:analysis.id});assert.equal(plannedJob.tasks[0].status,'completed');assert.equal(plannedJob.analysisId,analysis.id);assert.equal(plannedJob.tokens.reserved,savedTokens.reserved);await until(()=>!planning.active.has(plannedJob.id));assert.equal(plannedJob.status,'completed',JSON.stringify(plannedJob.tasks));assert.equal(orchestratorCalls(),beforeReuse);assert.equal(plannedJob.tokens.input,800);assert.equal(plannedJob.tokens.output,800);assert.deepEqual(analysis.tokens,savedTokens);assert.equal(plannedJob.analysisProvider.id,'planner');assert.ok(planning.audit.some(a=>a.jobId===plannedJob.id&&a.action==='requirements_analysis_reused'));
await assert.rejects(()=>planning.analyze({brief:'TEST_INVALID_REQUIREMENTS'}),e=>e.code==='analysis_failed');assert.equal(planning.state.analyses.length,1);assert.ok(planning.audit.some(a=>a.action==='requirements_analysis_failed'));assert.equal(planning.active.size,0);
// Run the actual HTTP server against a copied disposable app, so UI state is untouched.
const httpApp=path.join(fixture,'http-app');await fs.mkdir(path.join(httpApp,'dist'),{recursive:true});const backend=path.resolve(here,'..');await fs.copyFile(path.join(backend,'server.mjs'),path.join(httpApp,'server.mjs'));await fs.cp(path.join(backend,'lib'),path.join(httpApp,'lib'),{recursive:true});await fs.writeFile(path.join(httpApp,'dist','index.html'),'<!doctype html><title>Test</title>');
const portProbe=http.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const testPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));const server=spawn(process.execPath,[path.join(httpApp,'server.mjs'),'--port',String(testPort)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let serverLog='';server.stdout.on('data',chunk=>serverLog+=chunk);server.stderr.on('data',chunk=>serverLog+=chunk);process.on('exit',()=>server.kill());await until(()=>serverLog.includes('http://127.0.0.1:'));
const base=`http://127.0.0.1:${testPort}`;assert.equal((await fetch(base)).status,200);assert.equal((await fetch(`${base}/api/status`)).status,200);
const forgedHostStatus=await new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:testPort,path:'/api/status',headers:{Host:`evil.test:${testPort}`}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(forgedHostStatus,403);
assert.equal((await fetch(`${base}/api/config`,{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status,403);assert.equal((await fetch(`${base}/api/config`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'x=1'})).status,415);assert.equal((await fetch(`${base}/.runtime/state.json`)).status,403);assert.equal((await fetch(`${base}/api/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brief:'write a plan'})})).status,409);
const catalog=await(await fetch(`${base}/api/providers`)).json();assert.equal(catalog.presets.length,11);assert.equal(catalog.presets.find(p=>p.id==='ollama').keyRequired,false);
const local=await(await fetch(`${base}/api/providers/local`)).json();assert.equal(local.providers.length,2);assert.ok(local.providers.every(p=>Array.isArray(p.models)&&typeof p.available==='boolean'));
const apiConnected=await fetch(`${base}/api/providers/connect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({presetId:'custom',baseUrl:`${endpoint}/v1`,model:'local-chat',apiKey:'http-only-secret'})});assert.equal(apiConnected.status,200);assert.equal((await apiConnected.json()).provider.hasKey,true);assert.ok(!(await fs.readFile(path.join(httpApp,'.runtime','state.json'),'utf8')).includes('http-only-secret'));
const apiMultiple=await Promise.all(['http-model-one','http-model-two'].map(connectionId=>fetch(`${base}/api/providers/connect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({presetId:'custom',connectionId,baseUrl:`${endpoint}/v1`,model:connectionId,apiKey:'http-multiple-secret'})})));
for(const [i,response]of apiMultiple.entries()){assert.equal(response.status,200);const data=await response.json();assert.equal(data.connectionId,['http-model-one','http-model-two'][i]);assert.equal(data.provider.id,data.connectionId);}
const apiMultiStatus=await(await fetch(`${base}/api/status`)).json();assert.equal(apiMultiStatus.config.providers.length,3);assert.equal(apiMultiStatus.config.agentProviders.orchestrator,'custom');assert.ok(!(await fs.readFile(path.join(httpApp,'.runtime','state.json'),'utf8')).includes('http-multiple-secret'));
const analyzedResponse=await fetch(`${base}/api/requirements/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brief:'Analyze a weekly report',kind:'auto'})});assert.equal(analyzedResponse.status,200);const apiAnalysis=(await analyzedResponse.json()).analysis;assert.ok(apiAnalysis.id.startsWith('analysis-'));assert.equal(apiAnalysis.provider,'custom');const statusAfterAnalysis=await(await fetch(`${base}/api/status`)).json();assert.equal(statusAfterAnalysis.analyses[0].id,apiAnalysis.id);assert.equal(statusAfterAnalysis.jobs.length,0);assert.ok(!(await fs.readFile(path.join(httpApp,'.runtime','state.json'),'utf8')).includes('http-only-secret'));server.kill();
await new Promise(resolve=>mock.close(resolve));
console.log(JSON.stringify({ok:true,fixture,assertions:['same-service models have independent connection IDs and keys','stable reconnection preserves other models and routing','failed multi-model connection preserves config keys and disk','invalid connection IDs rejected before requests','endpoint and protocol changes never reuse old keys','concurrent settings and connection updates remain ordered','connection limit rejects extra requests before model test','multi-model keys stay memory-only','concurrent multi-model HTTP API','secret/path/Windows-alias/hardlink exclusions','real local model requests','native Anthropic protocol','key omission and memory-only storage','changed endpoint clears key','8-stage DAG','7 isolated worktrees','completed resume never rewrites','stage files reach final worktree','parallel file conflict remains blocked on retry','source untouched until approved merge','commit/merge/revert approvals','dirty main-tree merge blocked','tests require approval','rejected tests block downstream','retry creates a new approval','restart interrupted/unknown protection','accepted skills and audit','HTTP host/origin/content-type guards','runtime state not served','11 provider presets and non-reasoning discovery','failed quick connection preserves config/key/disk','quick reconnect replaces rather than duplicates','quick connection never sends old key to changed endpoint','keyless old provider remapped on successful connection','daily work creates isolated managed repository without user path','managed Git identity does not change source repo identity','code tasks still require repository','provider discovery/connect HTTP APIs','requirements analysis needs no Git or workspace','analysis stores structured scope/questions and token usage without keys','changed brief/kind and missing analysis rejected','reused analysis skips orchestration and inherits token usage','invalid analysis rejected with audited failure','requirements analysis HTTP API and persisted status'],modelRequests:calls.length},null,2));
