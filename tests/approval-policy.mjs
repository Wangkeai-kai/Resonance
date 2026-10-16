import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../lib/engine.mjs';

test('approval preference is validated and persisted; unsupported modes do not enable automatic actions',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-policy-'));
  const engine=await new Engine(runtime).init();
  await engine.config({approvalMode:'auto_sandbox'});
  const reloaded=await new Engine(runtime).init();assert.equal(reloaded.state.config.approvalMode,'auto_sandbox');
  await assert.rejects(()=>engine.config({approvalMode:'approve_everything'}),/审批方式无效/);
  await engine.config({approvalMode:'ask'});assert.equal(engine.state.config.approvalMode,'ask');
});

test('only opted-in sandbox tests are automatic, and missing Docker remains pending',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-policy-'));
  const engine=await new Engine(runtime).init();
  const workspace=path.join(runtime,'workspace');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'note.md'),'hello');
  engine.workspace=async()=>workspace;engine.writeFiles=async()=>{};
  engine.model=async()=>({summary:'test',files:[],command:{image:'node:22-alpine',argv:['node','--test']}});
  let decisions=[];
  engine.decide=async(id,approved)=>{decisions.push({id,approved});const item=engine.state.approvals.find(a=>a.id===id);item.status='approved';const task=engine.state.jobs.find(j=>j.id===item.jobId).tasks.find(t=>t.id==='tester');task.status='completed';return {approval:item};};
  for(const [mode,docker,expected] of [['ask',true,0],['auto_sandbox',false,0],['auto_sandbox',true,1]]){
    decisions=[];engine.capabilities.docker=docker;
    const task={id:'tester',deps:[],status:'running'};
    const job={id:`job-${mode}-${docker}`,kind:'code',approvalMode:mode,tasks:[{id:'orchestrator',result:{requirements:[]}},task],artifacts:[]};engine.state.jobs.push(job);
    await engine.executeTask(job,task);assert.equal(decisions.length,expected);assert.equal(task.status,expected?'completed':'awaiting_approval');
  }
  const before=decisions.length;const job=engine.state.jobs.at(-1);job.worktree=workspace;
  const item=await engine.approval(job,{id:'git'},'commit','提交',{files:['note.md']},{message:'test'});
  assert.equal(item.status,'pending');assert.equal(decisions.length,before,'commit must never inherit sandbox auto approval');
});
