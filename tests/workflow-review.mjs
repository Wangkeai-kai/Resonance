import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWorkflowReview, workflowReview } from '../lib/workflow-review.mjs';
import { validateWorkflowArtifact } from '../lib/workflows.mjs';

function fixture() {
  const artifact = { kind: 'ppt', title: '读书会提案', brief: '为志愿者制定执行方案', slides: Array.from({ length: 4 }, (_, i) => ({ type: i === 0 ? 'cover' : 'content', title: `第 ${i + 1} 页`, subtitle: '待确认日期', kicker: '', footer: '', items: i === 0 ? [] : [{ title: '安排', body: '先确认场地与日期，再征集报名。' }] })) };
  const job = { id: 'review-test', status: 'completed', deliverable: validateWorkflowArtifact('ppt', [{ path: 'artifacts/presentation.json', content: JSON.stringify(artifact) }]) };
  const engine = { writes: [], events: [], async persist() { this.writes.push(structuredClone(job)); }, async record(...event) { this.events.push(event); } };
  const input = action => { const review = workflowReview(job); return { action, sourceHash: review.sourceHash, version: review.versions.length }; };
  return { job, engine, input };
}

test('review comments gate approval; resolution and reopening reset approval', async () => {
  const { job, engine, input } = fixture();
  await applyWorkflowReview(engine, job, { ...input('comment'), slide: 1, text: '请核实活动日期' });
  assert.equal(job.review.comments[0].slide, 1);
  assert.equal(job.review.comments[0].version, 1);
  await assert.rejects(() => applyWorkflowReview(engine, job, input('approve')), e => e.status === 409 && /未解决/.test(e.message));
  assert.equal(job.review.approved, false);
  const commentId = job.review.comments[0].id;
  await applyWorkflowReview(engine, job, { ...input('resolve'), commentId, resolved: true });
  await applyWorkflowReview(engine, job, input('approve'));
  assert.equal(job.review.approved, true);
  assert.ok(job.review.approvedAt);
  await applyWorkflowReview(engine, job, { ...input('resolve'), commentId, resolved: false });
  assert.equal(job.review.approved, false);
  assert.equal(engine.events.length, 4);
});

test('editing creates a validated new version, preserves original and invalidates approval', async () => {
  const { job, engine, input } = fixture();
  const original = structuredClone(job.deliverable.artifact);
  const stale = input('approve');
  await applyWorkflowReview(engine, job, input('approve'));
  await applyWorkflowReview(engine, job, { ...input('edit-slide'), slide: 0, content: { title: '新版读书会计划', subtitle: '修改说明', items: [] } });
  assert.equal(job.review.versions.length, 2);
  assert.equal(job.review.approved, false);
  assert.deepEqual(job.deliverable.artifact, original);
  assert.deepEqual(job.review.versions[0].artifact, original);
  assert.equal(job.review.versions[1].artifact.title, '新版读书会计划');
  assert.equal(job.review.versions[1].artifact.slides[0].title, '新版读书会计划');
  const saved = JSON.stringify(job);
  await assert.rejects(() => applyWorkflowReview(engine, job, stale), e => e.status === 409);
  await assert.rejects(() => applyWorkflowReview(engine, job, { ...input('approve'), sourceHash: 'incorrect-hash' }), e => e.status === 409);
  await assert.rejects(() => applyWorkflowReview(engine, job, { ...input('edit-slide'), slide: 1, content: { title: 'x'.repeat(65), subtitle: '', items: [{ title: '事项', body: '正文' }] } }), e => e.status === 400);
  assert.equal(JSON.stringify(job), saved);
});

test('new model source rejects stale edits without mutating review history, then starts a new review', async () => {
  const { job, engine, input } = fixture();
  const stale = input('comment');
  await applyWorkflowReview(engine, job, { ...stale, text: '旧版意见' });
  const oldReview = structuredClone(job.review);
  job.deliverable.artifact.title = '模型重新生成的版本';
  const before = JSON.stringify(job);
  await assert.rejects(() => applyWorkflowReview(engine, job, { ...stale, text: '过期意见' }), e => e.status === 409);
  assert.equal(JSON.stringify(job), before);
  const current = workflowReview(job);
  assert.notEqual(current.sourceHash, stale.sourceHash);
  assert.deepEqual(job.reviewHistory[0], oldReview);
  assert.deepEqual(current.comments, []);
  await applyWorkflowReview(engine, job, { ...input('comment'), text: '新版意见' });
  assert.equal(job.review.comments[0].text, '新版意见');
});

test('concurrent review saves serialize so comments are never overwritten', async () => {
  const { job, engine, input } = fixture();
  const sameVersion = input('comment');
  await Promise.all(['核实日期', '补充来源'].map(text => applyWorkflowReview(engine, job, { ...sameVersion, text })));
  assert.deepEqual(job.review.comments.map(c => c.text), ['核实日期', '补充来源']);
  const edit = input('edit-slide');
  const results = await Promise.allSettled(['标题一', '标题二'].map(title => applyWorkflowReview(engine, job, { ...edit, slide: 0, content: { title, subtitle: '', items: [] } })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(job.review.versions.length, 2);
});

test('persistence failure restores exact previous review and can be retried', async () => {
  const { job, engine, input } = fixture();
  const request = { ...input('comment'), text: '此修改不能丢失原状态' };
  const before = JSON.stringify(job);
  const persist = engine.persist; let fail = true;
  engine.persist = async function () { if (fail) { fail = false; throw new Error('fixture disk unavailable'); } return persist.call(this); };
  await assert.rejects(() => applyWorkflowReview(engine, job, request), /disk unavailable/);
  assert.equal(JSON.stringify(job), before);
  assert.deepEqual(engine.writes.at(-1), JSON.parse(before));
  assert.equal(engine.events.length, 0);
  await applyWorkflowReview(engine, job, request);
  assert.equal(job.review.comments.length, 1);
});

test('audit failure rolls persisted state back, including absence of an initial review', async () => {
  const { job, engine } = fixture();
  const expected = workflowReview(structuredClone(job));
  const before = structuredClone(job);
  engine.record = async () => { throw new Error('fixture audit unavailable'); };
  await assert.rejects(() => applyWorkflowReview(engine, job, { action: 'comment', sourceHash: expected.sourceHash, version: 1, text: '不能保存的批注' }), /audit unavailable/);
  assert.deepEqual(job, before);
  assert.equal(Object.hasOwn(job, 'review'), false);
  assert.equal(Object.hasOwn(job, 'reviewHistory'), false);
  assert.equal(engine.writes.length, 2);
  assert.deepEqual(engine.writes.at(-1), before);
});

test('invalid review operations and unfinished jobs cannot mutate saved review', async () => {
  const { job, engine, input } = fixture();
  const state = input('approve');
  const before = JSON.stringify(job);
  for (const request of [
    { ...state, action: 'comment', text: 'x', slide: -1 },
    { ...state, action: 'comment', text: 'x', slide: 4 },
    { ...state, action: 'comment', text: ' ' },
    { ...state, action: 'comment', text: 'x'.repeat(2001) },
    { ...state, action: 'resolve', commentId: 'missing', resolved: true },
    { ...state, action: 'unsupported' },
  ]) await assert.rejects(() => applyWorkflowReview(engine, job, request));
  assert.equal(JSON.stringify(job), before);
  job.status = 'running';
  await assert.rejects(() => applyWorkflowReview(engine, job, state), e => e.status === 409);
  assert.equal(engine.writes.length, 0);
});

test('a checked draft with failed acceptance may be annotated but cannot be falsely finalized',async()=>{
 const {job,engine,input}=fixture();job.status='failed';job.tasks=[{id:'tester',status:'completed'}];
 await applyWorkflowReview(engine,job,{...input('comment'),text:'产品名称需要确认'});
 assert.equal(job.review.comments.length,1);assert.equal(job.status,'failed');
 await assert.rejects(applyWorkflowReview(engine,job,input('approve')),/验收尚未通过/);assert.equal(job.review.approved,false);
});
