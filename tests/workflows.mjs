import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { WORKFLOWS, buildWorkflow, stageInstructions, validateWorkflowArtifact } from '../lib/workflows.mjs';

function presentation(count = 8) {
  return { kind: 'ppt', title: '校园读书活动提案', brief: '为图书馆志愿者做一份活动方案', slides: Array.from({ length: count }, (_, i) => ({
    type: i === 0 ? 'cover' : i === count - 1 ? 'closing' : 'content', title: `第 ${i + 1} 页活动计划`,
    subtitle: '依据已提供的活动目标制定建议', kicker: '读书活动', footer: '建议稿，待确认安排',
    items: i === 0 ? [] : [{ title: '执行事项', body: '征集读者反馈，再决定读书会的时间与形式。' }],
  })) };
}
const pptFiles = artifact => [{ path: 'artifacts/presentation.json', content: JSON.stringify(artifact) }];
const codeOf = code => error => error.status === 400 && error.code === code;

test('five workflow templates have complete stage and field definitions', () => {
  assert.deepEqual(WORKFLOWS.map(workflow => workflow.id), ['ppt', 'website', 'document', 'project', 'code']);
  for (const workflow of WORKFLOWS) {
    assert.equal(workflow.steps.length, 8);
    assert.ok(workflow.description && workflow.deliverables.length);
    assert.equal(new Set(workflow.fields.map(field => field.id)).size, workflow.fields.length);
    for (const stage of ['orchestrator', 'context', 'architect', 'developer', 'tester', 'docs', 'regression', 'git']) assert.ok(stageInstructions(workflow.id, stage).length > 50);
  }
  assert.equal(stageInstructions(null, 'developer'), '');
});

test('template values stay separate from brief for requirement analysis reuse', () => {
  const brief = '为图书馆志愿者做一份活动方案';
  const result = buildWorkflow({ workflowId: 'ppt', brief, templateValues: { audience: '图书馆志愿者', slideCount: 6, materials: '地点：校图书馆二楼' } });
  assert.equal(result.brief, brief);
  assert.equal(result.kind, 'ppt');
  assert.equal(result.workflow.values.slideCount, '6');
  assert.equal(result.workflow.values.style, '清晰、简洁');
  assert.equal(result.workflow.values.materials, '地点：校图书馆二楼');
  assert.equal(buildWorkflow({ brief, workflowId: 'ppt' }).workflow.values.slideCount, '8');
  assert.equal(buildWorkflow({ brief, kind: 'auto' }).workflow, null);
});

test('invalid template identifiers, conflicting kinds and unsupported parameters are rejected', () => {
  for (const input of [
    { workflowId: 'unknown' }, { workflowId: 'ppt', kind: 'website' },
    { workflowId: 'ppt', templateValues: [] }, { workflowId: 'ppt', templateValues: { madeUp: 'value' } },
    { workflowId: 'ppt', templateValues: { audience: { injected: true } } },
    { workflowId: 'ppt', templateValues: { slideCount: '3' } },
    { workflowId: 'ppt', templateValues: { slideCount: '21' } },
    { workflowId: 'ppt', templateValues: { slideCount: '8.5' } },
    { workflowId: 'ppt', templateValues: { materials: 'x'.repeat(12001) } },
    { templateValues: { audience: 'someone' } },
  ]) assert.throws(() => buildWorkflow(input), codeOf('workflow_invalid'));
});

test('PPT validation returns renderable AI artifact without inserting template content', async () => {
  const source = presentation();
  const result = validateWorkflowArtifact('ppt', pptFiles(source), { slideCount: '8' });
  assert.equal(result.artifact.source, 'ai-workflow');
  assert.equal(result.artifact.title, source.title);
  assert.deepEqual(result.artifact.slides, source.slides);
  assert.equal(result.checks[0].status, 'passed');
  assert.match(result.limitations.join(' '), /未执行 PowerPoint/);
  const renderer = { module: { exports: {} }, TextEncoder, Blob };
  vm.runInNewContext(await fs.readFile(new URL('../dist/artifacts.js', import.meta.url), 'utf8'), renderer);
  const bytes = renderer.module.exports.toPptx(result.artifact);
  assert.equal(Buffer.from(bytes).readUInt32LE(0), 0x04034b50);
  assert.ok(Buffer.from(bytes).includes(Buffer.from('ppt/slides/slide8.xml')));
  assert.ok(Buffer.from(bytes).includes(Buffer.from('征集读者反馈')));
});

test('PPT validation rejects invalid JSON, missing files and impossible page counts', () => {
  assert.throws(() => validateWorkflowArtifact('ppt', [{ path: 'artifacts/presentation.json', content: 'not json' }]), /不是有效 JSON/);
  assert.throws(() => validateWorkflowArtifact('ppt', [{ path: 'README.md', content: 'some notes' }]), /缺少必需文件/);
  assert.throws(() => validateWorkflowArtifact('ppt', pptFiles(presentation(3))), /4–20/);
  assert.throws(() => validateWorkflowArtifact('ppt', pptFiles(presentation(21))), /4–20/);
  assert.throws(() => validateWorkflowArtifact('ppt', pptFiles(presentation(6)), { slideCount: '8' }), /页数.*不一致/);
});

test('PPT layouts survive validation and reject incompatible or unsafe layout metadata', async () => {
  const source=presentation();
  source.slides[1].layout='comparison';source.slides[1].tone='sage';
  source.slides[1].items.push({title:'第二种方案',body:'具体对照内容'});
  const artifact=validateWorkflowArtifact('ppt',pptFiles(source)).artifact;
  assert.equal(artifact.slides[1].layout,'comparison');assert.equal(artifact.slides[1].tone,'sage');
  const renderer={module:{exports:{}},TextEncoder,Blob};
  vm.runInNewContext(await fs.readFile(new URL('../dist/artifacts.js',import.meta.url),'utf8'),renderer);
  const html=renderer.module.exports.slideHtml(artifact.slides[1],1,8);
  assert.match(html,/data-layout="comparison"/);
  assert.ok(html.includes('第二种方案'));
  const ppt=Buffer.from(renderer.module.exports.toPptx(artifact)).toString();
  assert.ok(ppt.includes('DFEBE3'));assert.ok(ppt.includes('第二种方案'));
  source.slides[1].layout='focus';assert.throws(()=>validateWorkflowArtifact('ppt',pptFiles(source)),/数量不一致/);
  source.slides[1].layout='editorial';source.slides[1].tone='url(evil)';assert.throws(()=>validateWorkflowArtifact('ppt',pptFiles(source)),/配色无效/);
});

test('PPT validation rejects overflowing, missing and malformed fields', () => {
  const mutations = [
    artifact => { artifact.kind = 'document'; },
    artifact => { artifact.title = ''; },
    artifact => { artifact.slides[1].title = 'x'.repeat(65); },
    artifact => { artifact.slides[1].items[0].body = 'x'.repeat(101); },
    artifact => { artifact.slides[1].items = []; },
    artifact => { artifact.slides[1].items = Array.from({ length: 5 }, () => ({ title: 'a', body: 'b' })); },
    artifact => { artifact.slides[1].items = [null]; },
    artifact => { artifact.slides[0].items = [{ title: 'invisible on cover', body: 'bad' }]; },
    artifact => { artifact.slides[1].type = 'cover'; },
    artifact => { artifact.slides[1].title = 'bad\u0000xml'; },
  ];
  for (const mutate of mutations) {
    const artifact = presentation(); mutate(artifact);
    assert.throws(() => validateWorkflowArtifact('ppt', pptFiles(artifact)), codeOf('workflow_artifact_invalid'));
  }
});

test('website requires one standalone HTML document and never claims interaction tests', () => {
  const html = '<!doctype html><html><head><title>校园活动</title><style>body{color:black}</style></head><body><h1>活动报名</h1></body></html>';
  const result = validateWorkflowArtifact('website', [{ path: 'index.html', content: html }]);
  assert.equal(result.artifact.html, html);
  assert.equal(result.artifact.title, '校园活动');
  assert.match(result.limitations.join(' '), /未执行浏览器交互/);
  for (const content of ['<h1>incomplete fragment</h1>', html.replace('</head>', '<link rel="stylesheet" href="style.css"></head>'), html.replace('</body>', '<script src="main.js"></script></body>')]) {
    assert.throws(() => validateWorkflowArtifact('website', [{ path: 'index.html', content }]), codeOf('workflow_artifact_invalid'));
  }
});

test('document output has real content rather than only a placeholder file', () => {
  const markdown = '# 图书馆读书会\n\n## 目标与建议\n\n' + '本方案建议先收集读者阅读偏好，再讨论场地和时间。场地容量尚未提供，应向图书馆核实后决定名额。'.repeat(4);
  const result = validateWorkflowArtifact('document', [{ path: 'artifacts/document.md', content: markdown }]);
  assert.equal(result.artifact.kind, 'document');
  assert.equal(result.artifact.markdown, markdown);
  assert.throws(() => validateWorkflowArtifact('document', [{ path: 'artifacts/document.md', content: '# TODO\n\n## Draft' }]), /至少 160/);
});

test('project output requires work packages, milestones, dependencies and evidence sections', () => {
  const sections = ['项目目标', '工作包', '里程碑', '验收标准', '依赖与风险', '依据与假设'];
  const markdown = '# 读书会执行计划\n\n' + sections.map(section => `## ${section}\n\n向读者征集阅读偏好，确定活动时间并申请场地；当前安排为建议，仍需馆方确认。\n\n`).join('');
  assert.equal(validateWorkflowArtifact('project', [{ path: 'artifacts/project-plan.md', content: markdown }]).artifact.kind, 'project');
  assert.throws(() => validateWorkflowArtifact('project', [{ path: 'artifacts/project-plan.md', content: markdown.replace('## 依据与假设', '## 其他') }]), /依据与假设/);
  const blank = markdown.replace(/## 工作包\n\n[^#]+/, '## 工作包\n\n');
  assert.throws(() => validateWorkflowArtifact('project', [{ path: 'artifacts/project-plan.md', content: blank }]), /工作包/);
});

test('unsafe paths, duplicate paths and oversized files are rejected', () => {
  for (const path of ['../presentation.json', '/artifacts/presentation.json', 'C:/tmp/presentation.json', '.env', '.git/config']) assert.throws(() => validateWorkflowArtifact('code', [{ path, content: 'text' }]), /不安全/);
  assert.throws(() => validateWorkflowArtifact('code', [{ path: 'a.txt', content: 'one' }, { path: 'a.txt', content: 'two' }]), /重复/);
  assert.throws(() => validateWorkflowArtifact('code', [{ path: 'a.txt', content: 'x'.repeat(8*1024*1024+1) }]), /8 MB/);
  assert.throws(() => validateWorkflowArtifact('code', Array.from({length:513},(_,index)=>({path:index+'.txt',content:'text'}))), /512/);
  assert.equal(validateWorkflowArtifact('code',Array.from({length:150},(_,index)=>({path:index+'.txt',content:'x'.repeat(8000)}))).checks[0].status,'passed');
  const result = validateWorkflowArtifact('code', [{ path: 'src/main.js', content: 'console.log("hello")' }]);
  assert.equal(result.artifact, null);
  assert.match(result.limitations.join(' '), /不能以此替代测试/);
});
