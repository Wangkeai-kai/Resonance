import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { before, after, test } from 'node:test';
import { Engine } from '../lib/engine.mjs';

const work = tmpdir();
let fixture, engine, mock;
const calls = [];

function presentation(count) {
  return { kind: 'ppt', title: '图书馆读书会提案', brief: '为图书馆志愿者制定读书会方案', slides: Array.from({ length: count }, (_, i) => ({
    type: i === 0 ? 'cover' : i === count - 1 ? 'closing' : 'content', title: `读书会第 ${i + 1} 页`,
    subtitle: '活动地点为校图书馆二楼', kicker: '读书会提案', footer: '人数与日期待馆方确认',
    items: i === 0 ? [] : [{ title: i === count - 1 ? '下一步' : '执行安排', body: '由志愿者收集阅读偏好，再向馆方确认场地、日期与人数。' }],
  })) };
}

async function finished(job) {
  const until = Date.now() + 60000;
  while (engine.active.has(job.id)) {
    if (Date.now() > until) throw new Error(`Workflow timed out: ${JSON.stringify(job.tasks.map(t => ({ id: t.id, status: t.status, error: t.error })))}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

before(async () => {
  await fs.mkdir(work, { recursive: true });
  fixture = await fs.mkdtemp(path.join(work, 'workflow-pipeline-'));
  mock = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), system = body.messages.find(m => m.role === 'system').content;
      const agent = system.match(/You are the (\w+) agent/)[1];
      const input = JSON.parse(body.messages.find(m => m.role === 'user').content);
      calls.push({ agent, system, input, model: body.model });
      let result;
      if (agent === 'orchestrator') result = { summary: '制作读书会提案', requirements: [{ id: 'r1', text: '为志愿者制作指定页数 PPT', acceptance: '包含场地、执行安排、下一步及未知项说明' }], assignments: [], risks: ['日期和人数待确认'], deliverables: ['artifacts/presentation.json'] };
      if (agent === 'context') result = { summary: '提供的唯一事实是地点，其他安排为建议', modules: [], dependencies: [], interfaces: [], constraints: ['地点为校图书馆二楼'], missingContext: ['日期和人数'] };
      if (agent === 'architect') result = { summary: '封面、执行安排与结尾行动', modules: [], directoryStructure: ['artifacts/presentation.json', 'docs/presentation-notes.md'], interfaces: [], risks: ['不要编造参与人数'], implementationSteps: ['按指定页数组织内容'] };
      if (agent === 'developer') {
        const count = input.brief.includes('WRONG_COUNT') ? 4 : Number(input.workflow.values.slideCount);
        result = { summary: '根据测试材料生成结构化页面', files: [{ path: 'artifacts/presentation.json', content: JSON.stringify(presentation(count)) }, { path: 'docs/presentation-notes.md', content: '# 初版说明\n\n地点来自用户资料，其余为建议。' }], notes: ['fixture model output'], risks: [] };
      }
      if (agent === 'docs') result = { summary: '记录来源与待确认项', files: [{ path: 'docs/presentation-notes.md', content: '# 演示说明\n\n地点：校图书馆二楼，来源为任务资料。日期、人数和具体阅读书目尚未提供。结构校验不代表内容准确或视觉验收通过。\n' }], limitations: ['未执行 PowerPoint 视觉检查'] };
      if (agent === 'regression') result = { summary: '逐项核对内容', passed: !input.brief.includes('MISSING_REQUIREMENT'), checks: [{ requirementId: 'r1', status: input.brief.includes('MISSING_REQUIREMENT') ? 'partial' : 'passed', evidence: 'artifacts/presentation.json 含封面、执行安排和下一步；docs/presentation-notes.md 含资料出处及未知项' }], missing: input.brief.includes('MISSING_REQUIREMENT') ? ['缺少已确认日期'] : [], risks: ['日期和人数仍需人工确认'] };
      if (agent === 'git') result = { summary: '文件已生成，可人工审阅和导出', commitMessage: 'docs: draft reading event presentation', prTitle: 'Draft reading event presentation', prBody: 'Adds slide JSON and source notes.', changes: ['artifacts/presentation.json', 'docs/presentation-notes.md'], risks: ['尚未人工审阅'] };
      if (!result) throw new Error(`Unexpected model stage ${agent}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 120 } }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  engine = await new Engine(path.join(fixture, 'app')).init();
  assert.equal(engine.capabilities.git, true, 'Git must be available for real worktree integration');
  engine.capabilities.docker = false;
  await engine.config({ providers: [{ id: 'fixture', name: 'Local mock', type: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'fixture-chat' }] });
});

after(async () => { if (mock) await new Promise(resolve => mock.close(resolve)); });

test('PPT workflow completes all eight stages with real isolated Git worktrees and no Docker', async () => {
  const job = await engine.create({ brief: '为图书馆志愿者制作读书会提案', workflowId: 'ppt', templateValues: { audience: '图书馆志愿者', slideCount: '6', materials: '地点：校图书馆二楼' }, budget: 100000 });
  await finished(job);
  assert.equal(job.status, 'completed', JSON.stringify(job.tasks.map(t => ({ id: t.id, status: t.status, error: t.error }))));
  assert.equal(job.tasks.length, 8);
  assert.ok(job.tasks.every(t => t.status === 'completed'));
  assert.deepEqual(job.tasks.map(t => t.title), job.workflow.steps);
  assert.equal(new Set(job.tasks.map(t => t.worktree).filter(Boolean)).size, 7);
  assert.equal(job.managedWorkspace, true);
  assert.equal(job.deliverable.artifact.kind, 'ppt');
  assert.equal(job.deliverable.artifact.source, 'ai-workflow');
  assert.equal(job.deliverable.artifact.slides.length, 6);
  assert.equal(job.deliverable.checks[0].status, 'passed');
  assert.match(job.deliverable.limitations.join(' '), /未执行 PowerPoint/);
  const tester = job.tasks.find(t => t.id === 'tester');
  assert.equal(tester.result.testReport.scope, 'document_structure_only');
  assert.equal(engine.state.approvals.length, 0);
  assert.ok(!engine.audit.some(a => a.jobId === job.id && a.action === 'command_started'));
  const output = JSON.parse(await fs.readFile(path.join(job.worktree, 'artifacts/presentation.json'), 'utf8'));
  assert.equal(output.slides.length, 6);
  assert.match(await fs.readFile(path.join(job.worktree, 'docs/presentation-notes.md'), 'utf8'), /校图书馆二楼/);
  assert.equal(job.tasks.find(t => t.id === 'developer').files.find(f => f.path === 'docs/presentation-notes.md').content, '# 初版说明\n\n地点来自用户资料，其余为建议。');
  assert.equal(job.tasks.find(t => t.id === 'docs').files.filter(f => f.path === 'docs/presentation-notes.md').length, 1);
  assert.equal(await fs.access(path.join(job.projectPath, 'artifacts/presentation.json')).then(() => true, () => false), false);
  assert.equal(job.commit, undefined);
  assert.equal(job.tasks.find(t => t.id === 'git').result.commitStatus, 'approval_required');
  const jobCalls = calls.filter(c => c.input.brief === job.brief);
  assert.equal(job.tasks.find(t=>t.id==='context').result.source,'local_inventory');
  assert.deepEqual(jobCalls.map(c => c.agent).sort(), ['architect', 'developer', 'docs', 'orchestrator', 'regression']);
  assert.ok(jobCalls.every(c => c.input.workflow.values.slideCount === '6'));
  assert.match(jobCalls.find(c => c.agent === 'developer').system, /artifacts\/presentation\.json/);
  const regression = jobCalls.find(c => c.agent === 'regression');
  assert.equal(regression.input.testReport.scope, 'document_structure_only');
  assert.ok(regression.input.files.some(f => f.path === 'artifacts/presentation.json'));
  assert.ok(regression.input.files.some(f => f.path === 'docs/presentation-notes.md'));
  const disk = JSON.parse(await fs.readFile(path.join(engine.runtime, 'state.json'), 'utf8'));
  assert.equal(disk.jobs.find(j => j.id === job.id).deliverable.artifact.slides.length, 6);
});

test('wrong page count stops tester and blocks regression and delivery', async () => {
  const job = await engine.create({ brief: 'WRONG_COUNT 制作六页读书会提案', workflowId: 'ppt', templateValues: { slideCount: '6' }, budget: 100000 });
  await finished(job);
  assert.equal(job.status, 'failed');
  assert.equal(job.tasks.find(t => t.id === 'tester').status, 'failed');
  assert.match(job.tasks.find(t => t.id === 'tester').error, /页数.*不一致/);
  assert.equal(job.tasks.find(t => t.id === 'regression').status, 'blocked');
  assert.equal(job.tasks.find(t => t.id === 'git').status, 'blocked');
  assert.equal(job.deliverable, undefined);
});

test('content draft stays reviewable while failed acceptance remains explicit and is not saved as a successful skill', async () => {
  const job = await engine.create({ brief: 'MISSING_REQUIREMENT 制作读书会提案', workflowId: 'ppt', templateValues: { slideCount: '4' }, budget: 100000 });
  await finished(job);
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks.find(t => t.id === 'tester').status, 'completed');
  assert.equal(job.tasks.find(t => t.id === 'regression').status, 'completed');
  assert.equal(job.tasks.find(t => t.id === 'regression').result.passed,false);
  assert.equal(job.reviewRequired,true);assert.equal(job.acceptanceStatus,'needs_review');
  assert.equal(job.tasks.find(t => t.id === 'git').status, 'completed');
  assert.ok(!engine.state.skills.some(s => s.sourceJobId === job.id));
  // A v1.1.0 artifact that already failed quality review can be recovered
  // without repeating any successful or billable stage.
  const reviewTask=job.tasks.find(task=>task.id==='regression'),gitTask=job.tasks.find(task=>task.id==='git'),before=calls.length;
  job.status='failed';reviewTask.status='failed';reviewTask.error='acceptance_failed: old missing items';gitTask.status='blocked';delete job.reviewRequired;
  await engine.actions(job,'resume');await finished(job);
  assert.equal(calls.length,before);assert.equal(job.status,'completed');assert.equal(job.reviewRequired,true);assert.equal(reviewTask.result.passed,false);
});

test('requirements analysis includes template values and rejects changed templates before creating workspaces', async () => {
  const request = { brief: '先分析读书会演示的完整需求', workflowId: 'ppt', templateValues: { slideCount: '6', audience: '图书馆志愿者' }, budget: 100000 };
  const analysis = await engine.analyze(request);
  assert.equal(analysis.kind, 'ppt');
  assert.equal(analysis.workflow.values.slideCount, '6');
  assert.equal(calls.at(-1).input.workflow.values.audience, '图书馆志愿者');
  const directories = await fs.readdir(path.join(engine.runtime, 'projects'));
  const countBefore = calls.length;
  await assert.rejects(() => engine.create({ ...request, analysisId: analysis.id, templateValues: { ...request.templateValues, slideCount: '8' } }), e => e.code === 'analysis_stale');
  await assert.rejects(() => engine.create({ brief: request.brief, kind: 'ppt', analysisId: analysis.id }), e => e.code === 'analysis_stale');
  assert.equal(calls.length, countBefore);
  assert.deepEqual(await fs.readdir(path.join(engine.runtime, 'projects')), directories);
  const job = await engine.create({ ...request, analysisId: analysis.id });
  await finished(job);
  assert.equal(job.status, 'completed', JSON.stringify(job.tasks.map(t => ({ id: t.id, error: t.error }))));
  assert.equal(job.deliverable.artifact.slides.length, 6);
  assert.equal(job.tasks[0].analysisId, analysis.id);
  assert.equal(calls.filter(c => c.agent === 'orchestrator' && c.input.brief === request.brief).length, 1);
});
