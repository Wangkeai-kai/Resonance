import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WorkflowLibrary, validateWorkflowDefinition} from '../lib/workflow-library.mjs';
import {buildWorkflow} from '../lib/workflows.mjs';

const definition = (extra = {}) => ({
  format:'gongming-workflow@1', name:'产品页', icon:'🌐', description:'需求到网站', version:'1.0.0', author:'测试',
  trigger:{kind:'website',starterPrompt:'制作网站：{{description}}\n补充：{{notes}}'},
  inputs:[{key:'description',label:'一句话描述',required:true},{key:'notes',label:'补充要求',multiline:true},{key:'audience',label:'读者',target:'audience',default:'访客'}],
  ...extra,
});
async function fixture(t) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(),'resonance-workflows-'));
  t.after(() => fs.rm(runtime,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const engine = {runtime,state:{config:{agentProviders:{developer:'connected-model'}},skills:[{id:'skill-one',name:'编码约定',enabled:true}]}};
  return {engine,store:await new WorkflowLibrary(engine).init()};
}

test('all builtins export round-trip and prepare existing executable workflows without inference', async t => {
  const {store} = await fixture(t);
  assert.equal(store.list().length,5);
  for (const workflow of store.list()) {
    assert.equal(workflow.source,'builtin');
    assert.deepEqual(validateWorkflowDefinition(store.export(workflow.id)),workflow.definition);
    const prepared = store.prepare(workflow.id,{inputs:{description:'我的实际需求'}});
    assert.equal(prepared.requiresConfirmation,true);
    assert.equal(prepared.brief,'我的实际需求');
    const actual = buildWorkflow(prepared);
    assert.equal(actual.kind,workflow.kind);
    assert.equal(actual.workflow.id,prepared.workflowId);
    assert.equal(prepared.modelAssignments.developer,'connected-model');
    assert.equal(prepared.enabledSkills[0].name,'编码约定');
    assert.equal(prepared.capabilities.urlImport,false);
  }
});

test('custom/imported definitions persist independently of model credentials and export as portable definitions', async t => {
  const {engine,store} = await fixture(t);
  engine.state.config.apiKey = 'do-not-export-this-key';
  const created = await store.create({action:'create',definition:definition()});
  assert.equal(created.workflow.source,'custom');
  const imported = await store.create({action:'import',definition:store.export(created.workflow.id)});
  assert.equal(imported.workflow.source,'imported');
  assert.notEqual(imported.workflow.id,created.workflow.id);
  const restarted = await new WorkflowLibrary(engine).init();
  assert.equal(restarted.get(created.workflow.id).definition.name,'产品页');
  assert.equal(restarted.get(imported.workflow.id).source,'imported');
  const raw = await fs.readFile(restarted.file,'utf8');
  assert.ok(!raw.includes('do-not-export-this-key'));
  assert.ok(!JSON.stringify(restarted.export(imported.workflow.id)).includes('connected-model'));
  assert.equal((await fs.stat(restarted.file.replace('.json','.previous.json'))).isFile(),true);
});

test('preparation substitutes only declared inputs, maps built-in values and cannot recursively execute templates', async t => {
  const {store} = await fixture(t);
  const {workflow} = await store.create({action:'import',definition:definition()});
  const prepared = store.prepare(workflow.id,{inputs:{description:'{{notes}} 与 $` 只是输入',notes:'功能范围',audience:'学生'}});
  assert.equal(prepared.brief,'制作网站：{{notes}} 与 $` 只是输入\n补充：功能范围');
  assert.equal(prepared.templateValues.audience,'学生');
  assert.equal(prepared.workflowId,'website');
  assert.throws(() => store.prepare(workflow.id,{inputs:{notes:'missing required'}}),/请填写一句话描述/);
  assert.throws(() => store.prepare(workflow.id,{inputs:{description:'safe',shell:'rm'}}),/不支持的工作流输入/);
  assert.throws(() => store.prepare(workflow.id,{inputs:{description:'x'.repeat(12001)}}),/最多 12000/);
});

test('pinning, ordering, editing and deleting survive restart; builtins stay intact', async t => {
  const {engine,store} = await fixture(t);
  const {workflow} = await store.create({action:'create',definition:definition()});
  await store.update(workflow.id,{action:'pin',pinned:true});
  await store.update(workflow.id,{action:'order',beforeId:'builtin-ppt'});
  await store.update(workflow.id,{action:'update',definition:definition({name:'新名称'})});
  const restarted = await new WorkflowLibrary(engine).init();
  assert.equal(restarted.get(workflow.id).pinned,true);
  assert.equal(restarted.get(workflow.id).name,'新名称');
  assert.equal(restarted.list()[0].id,workflow.id);
  await assert.rejects(restarted.remove('builtin-ppt'),{status:409});
  await assert.rejects(restarted.update('builtin-website',{action:'update',definition:definition()}),{status:409});
  await restarted.remove(workflow.id);
  assert.throws(() => restarted.get(workflow.id),{status:404});
  assert.equal((await new WorkflowLibrary(engine).init()).list().length,5);
});

test('unsupported authority and unverifiable overrides are rejected rather than silently ignored', () => {
  const cases = [
    {shell:'npm install'}, {tools:[{command:'whoami'}]}, {mcp:['external']},
    {pipeline:{stages:['idea','development']}}, {pipeline:{skipStages:['git']}},
    {pipeline:{stages:[],approvals:false}}, {model:{preferred:'gpt-something'}},
    {skills:['unavailable-skill']}, {constraints:{maxFiles:12000}},
  ];
  for (const extra of cases) assert.throws(() => validateWorkflowDefinition(definition(extra)),{status:400,code:'workflow_capability_unsupported'});
  assert.throws(() => validateWorkflowDefinition(definition({trigger:{kind:'website',starterPrompt:'yes',command:'whoami'}})),{code:'workflow_capability_unsupported'});
  assert.throws(() => validateWorkflowDefinition(JSON.parse('{"format":"gongming-workflow@1","__proto__":{"polluted":true}}')),{code:'workflow_capability_unsupported'});
  assert.equal({}.polluted,undefined);
});

test('schema rejects unused/missing/duplicate fields and invalid output parameters', () => {
  assert.throws(() => validateWorkflowDefinition(definition({inputs:[]})),/未定义输入/);
  assert.throws(() => validateWorkflowDefinition(definition({inputs:[{key:'description',label:'desc'},{key:'notes',label:'notes'},{key:'unused',label:'unused'}]})),/未用于提示词/);
  assert.throws(() => validateWorkflowDefinition(definition({inputs:[{key:'description',label:'desc'},{key:'description',label:'again'}]})),/唯一/);
  assert.throws(() => validateWorkflowDefinition(definition({trigger:{kind:'ppt',starterPrompt:'text',templateValues:{slideCount:'100'}},inputs:[]})),/4–20/);
  assert.throws(() => validateWorkflowDefinition(definition({trigger:{kind:'website',starterPrompt:'{{description.toString()}}'}})),/未定义输入/);
  assert.throws(() => validateWorkflowDefinition(definition({format:'other-app@1'})),/format/);
});

test('parallel writes serialize without lost changes, and failed snapshots roll memory back', async t => {
  const {store} = await fixture(t);
  const results = await Promise.all(Array.from({length:8},(_,index) => store.create({action:'create',definition:definition({name:'并发 '+index})})));
  assert.equal(new Set(results.map(result => result.workflow.id)).size,8);
  assert.equal(store.list().length,13);
  const before = JSON.stringify(store.status());
  const original = store.file;
  store.file = path.join(path.dirname(original),'missing-directory','never-written.json');
  await assert.rejects(store.create({action:'create',definition:definition()}),{code:'ENOENT'});
  assert.equal(JSON.stringify(store.status()),before);
});

test('damaged/missing persisted records fail closed and preserve original data for recovery', async t => {
  const {engine,store} = await fixture(t);
  await fs.writeFile(store.file,'{broken');
  await assert.rejects(new WorkflowLibrary(engine).init(),{code:'workflow_library_invalid'});
  assert.equal(await fs.readFile(store.file,'utf8'),'{broken');
  await fs.writeFile(store.file.replace('.json','.previous.json'),'preserved-backup');
  await fs.unlink(store.file);
  await assert.rejects(new WorkflowLibrary(engine).init(),{code:'history_recovery_required'});
  assert.equal(await fs.readFile(store.file.replace('.json','.previous.json'),'utf8'),'preserved-backup');
});

test('real HTTP routes expose executable preparation and keep legacy workflows compatible without any model call', {timeout:30000}, async t => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(),'resonance-workflow-http-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const child = spawn(process.execPath,[path.join(root,'server.mjs'),'--port',String(port)],{env:{...process.env,GONGMING_DATA_DIR:runtime},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log = '', spawnError;
  child.stdout.on('data',chunk => {log += chunk;}); child.stderr.on('data',chunk => {log += chunk;});
  child.on('error',error => {spawnError = error;});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit',resolve)); child.kill(); await stopped;
    }
    await fs.rm(runtime,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  });
  for (let attempt=0; !log.includes('http://127.0.0.1:'); attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || attempt > 150) throw Error('server did not start: '+log);
    await new Promise(resolve => setTimeout(resolve,50));
  }
  const request = async (route, method='GET', value) => {
    const response = await fetch('http://127.0.0.1:'+port+route,{method,headers:{'Content-Type':'application/json'},...(value === undefined ? {} : {body:JSON.stringify(value)})});
    return {status:response.status,data:await response.json()};
  };
  const legacy = await request('/api/workflows'); assert.equal(legacy.status,200); assert.equal(legacy.data.workflows.length,5);
  const listed = await request('/api/workflow-library'); assert.equal(listed.data.workflows.length,5);
  const saved = await request('/api/workflow-library','POST',{action:'import',definition:definition()});
  assert.equal(saved.status,201); const id = saved.data.workflow.id;
  const prepared = await request('/api/workflow-library/'+id+'/prepare','POST',{inputs:{description:'真实本地网站'}});
  assert.equal(prepared.status,200); assert.equal(prepared.data.workflowId,'website'); assert.equal(prepared.data.requiresConfirmation,true);
  assert.equal((await request('/api/status')).data.jobs.length,0);
  const exported = await request('/api/workflow-library/'+id+'/export'); assert.equal(exported.data.format,'gongming-workflow@1');
  const mismatch = await request('/api/jobs','POST',{brief:'够长的需求',workflowId:'ppt',libraryWorkflowId:id}); assert.equal(mismatch.status,400); assert.equal(mismatch.data.error,'workflow_library_mismatch');
  const denied = await request('/api/workflow-library','POST',{action:'import',definition:definition({shell:'whoami'})}); assert.equal(denied.status,400); assert.equal(denied.data.error,'workflow_capability_unsupported');
  assert.equal((await request('/api/workflow-library/'+id,'POST',{action:'pin',pinned:true})).data.workflow.pinned,true);
  assert.equal((await request('/api/workflow-library/'+id,'DELETE')).status,200);
  assert.equal((await request('/api/workflow-library')).data.workflows.length,5);
  assert.equal((await request('/api/status')).data.jobs.length,0);
});
