import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { hash } from '../lib/safety.mjs';
import { recoverHistory } from '../scripts/recover-history.mjs';

const work = tmpdir();
const blank = () => ({ version: 1, config: { projectPath: '', providers: [], agentProviders: {} }, jobs: [], analyses: [], skills: [], approvals: [] });

async function fixture() {
  await fs.mkdir(work, { recursive: true });
  const folder = await fs.mkdtemp(path.join(work, 'history-recovery-')), runtime = path.join(folder, 'workspace');
  await fs.mkdir(runtime);
  const state = blank(), events = []; let tick = 0;
  const emit = (jobId, agentId, action, details) => { const event = { id: `audit-${++tick}`, at: new Date(Date.UTC(2026, 9, 13, 0, 0, tick)).toISOString(), jobId, agentId, action, details }; events.push(event); return event; };
  emit(null, 'orchestrator', 'configuration_updated', { projectPath: '', providers: [{ id: 'deepseek', type: 'openai', model: 'fixture-chat' }], agentProviders: { orchestrator: 'deepseek', developer: 'deepseek', tester: 'deepseek', sandbox: 'deepseek' } });
  const create = async (jobId, approvedFailure) => {
    const project = path.join(runtime, 'projects', jobId); await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(project, '.git'), { recursive: true });
    await fs.writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(project, 'README.md'), '# Base\n');
    emit(jobId, 'orchestrator', 'job_created', { brief: '123', kind: 'work', baseCommit: 'a'.repeat(40), projectPath: project, managedWorkspace: true, budget: 100000 });
    for (const agent of ['orchestrator', 'context', 'architect', 'developer', 'docs', 'tester']) {
      emit(jobId, agent, 'task_started', { title: `历史 ${agent}` });
      emit(jobId, agent, 'model_request', { provider: 'deepseek', model: 'fixture-chat', estimatedTokens: 1000 });
      emit(jobId, agent, 'model_response', { provider: 'deepseek', model: 'fixture-chat', usage: { input: 100, output: 200 } });
      if (agent !== 'orchestrator') {
        const tree = path.join(runtime, 'worktrees', jobId, agent); await fs.mkdir(tree, { recursive: true });
        emit(jobId, agent, 'worktree_created', { path: tree, branch: `reviewfm/${jobId}/${agent}`, baseCommit: 'a'.repeat(40), inheritedFiles: [] });
        if (['developer', 'docs', 'tester'].includes(agent)) {
          const relative = agent === 'tester' ? 'tests/example.test.mjs' : 'docs/notes.md';
          const content = agent === 'developer' ? '# Initial\nA draft from the developer.\n' : agent === 'docs' ? '# Updated\nDocumentation changes retained independently.\n' : '// Fixture only; never execute this file.\n';
          const absolute = path.join(tree, relative); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content);
          emit(jobId, agent, 'file_written', { path: relative, worktree: tree, beforeHash: null, afterHash: hash(content), bytes: Buffer.byteLength(content) });
        }
      }
      if (agent === 'tester') {
        const id = `approval-${jobId.slice(4)}`;
        emit(jobId, agent, 'approval_requested', { id, type: 'sandbox', title: '历史测试审批', details: { image: 'node:22-alpine', argv: ['node', '--test'], cwd: path.join(runtime, 'worktrees', jobId, 'tester'), commands: [{ command: 'docker', args: ['run', 'node:22-alpine', 'node', '--test'] }], dockerAvailable: false } });
        emit(jobId, agent, 'task_finished', { status: 'awaiting_approval' });
        if (approvedFailure) { emit(jobId, 'sandbox', 'approval_decided', { id, type: 'sandbox', approved: true }); emit(jobId, 'sandbox', 'approved_action_failed', { id, error: 'docker_required: Docker 不可用；未执行任何主机测试命令' }); }
      } else emit(jobId, agent, 'task_finished', { status: 'completed' });
    }
  };
  await create('job-first', true); await create('job-second', false);
  const save = async () => { await fs.writeFile(path.join(runtime, 'state.json'), JSON.stringify(state, null, 2)); await fs.writeFile(path.join(runtime, 'audit.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n'); };
  await fs.writeFile(path.join(runtime, 'opaque-test-storage.bin'), Buffer.from([0,1,2,3,255]));
  await save(); return { folder, runtime, state, events, emit, save, backup: path.join(folder, 'workspace-recovery-backup-fixture') };
}

test('recovery backs up all runtime files, restores proven history, and keeps both agent file versions', async () => {
  const f = await fixture(), beforeState = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), beforeAudit = await fs.readFile(path.join(f.runtime, 'audit.jsonl'), 'utf8');
  const result = await recoverHistory(f.runtime, { backupDirectory: f.backup });
  assert.equal(result.jobsRecovered, 2); assert.equal(result.filesRecovered, 6); assert.equal(result.approvalsRecovered, 2);
  assert.deepEqual(result.skippedFiles, []); assert.equal(result.configurationActivated, false);
  assert.equal(await fs.readFile(path.join(f.backup, 'state.json'), 'utf8'), beforeState);
  assert.equal(await fs.readFile(path.join(f.backup, 'audit.jsonl'), 'utf8'), beforeAudit);
  assert.equal(await fs.readFile(path.join(f.runtime, 'audit.jsonl'), 'utf8'), beforeAudit);
  assert.deepEqual(await fs.readFile(path.join(f.backup, 'opaque-test-storage.bin')), Buffer.from([0,1,2,3,255]));
  assert.equal(await fs.readFile(path.join(f.backup, 'projects/job-first/.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  const recovered = JSON.parse(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'));
  assert.deepEqual(recovered.config, f.state.config);
  assert.equal(recovered.jobs[0].id, 'job-second');
  for (const job of recovered.jobs) {
    assert.equal(job.status, 'paused'); assert.equal(job.recoveryIncomplete, true); assert.equal(job.recovery.readOnly, true); assert.ok(job.recoveredAt);
    assert.equal(job.brief, '123'); assert.equal(job.kind, 'work'); assert.equal(job.baseCommit, 'a'.repeat(40)); assert.equal(job.tasks.length, 8);
    assert.deepEqual(job.tokens, { reserved: 6000, input: 600, output: 1200, usageIncomplete: true });
    assert.equal(job.recovery.configuration.providers[0].model, 'fixture-chat');
    assert.equal(job.recovery.configuration.providers[0].baseUrl, undefined);
    assert.equal(job.recovery.configuration.endpointNotRecovered, true); assert.deepEqual(job.configSnapshot.providers, []);
    assert.equal(job.tasks.find(task => task.id === 'orchestrator').result.requirements, undefined);
    assert.equal(job.tasks.find(task => task.id === 'orchestrator').result.originalResultUnavailable, true);
    assert.equal(job.tasks.find(task => task.id === 'regression').result, null);
    const notes = job.artifacts.filter(file => file.path === 'docs/notes.md');
    assert.equal(notes.length, 2); assert.notEqual(notes[0].content, notes[1].content); assert.notEqual(notes[0].agentId, notes[1].agentId);
    for (const file of job.artifacts) assert.equal(hash(file.content), file.hash);
  }
  assert.equal(recovered.jobs.find(job => job.id === 'job-first').historicalStatus, 'failed');
  assert.equal(recovered.jobs.find(job => job.id === 'job-second').historicalStatus, 'awaiting_approval');
  const failed = recovered.approvals.find(approval => approval.jobId === 'job-first'), cancelled = recovered.approvals.find(approval => approval.jobId === 'job-second');
  assert.equal(failed.status, 'failed'); assert.match(failed.result.error, /Docker/);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.historicalStatus, 'pending');
  for (const approval of recovered.approvals) { assert.equal(approval.action, null); assert.equal(approval.replayDisabled, true); assert.notEqual(approval.status, 'pending'); }
  assert.ok(!(await fs.readdir(f.runtime)).some(name => name.endsWith('.tmp')));
  assert.ok(!(await fs.readdir(f.folder)).some(name => name.endsWith('.lock')));
});

test('running recovery twice refuses to replace recovered jobs or make another backup', async () => {
  const f = await fixture(); await recoverHistory(f.runtime, { backupDirectory: f.backup });
  const before = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), siblings = await fs.readdir(f.folder);
  await assert.rejects(() => recoverHistory(f.runtime), e => e.code === 'existing_jobs');
  assert.equal(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.folder), siblings);
});

test('changed or missing artifacts are backed up but never presented as recovered original content', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.runtime, 'worktrees/job-first/developer/docs/notes.md'), '# Changed after audit\n');
  await fs.unlink(path.join(f.runtime, 'worktrees/job-second/tester/tests/example.test.mjs'));
  const result = await recoverHistory(f.runtime, { backupDirectory: f.backup });
  assert.equal(result.filesRecovered, 4); assert.equal(result.skippedFiles.length, 2);
  const restored = JSON.parse(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'));
  assert.ok(!restored.jobs.flatMap(job => job.artifacts).some(file => file.content.includes('Changed after audit')));
  assert.equal(await fs.readFile(path.join(f.backup, 'worktrees/job-first/developer/docs/notes.md'), 'utf8'), '# Changed after audit\n');
});

test('unsafe audit paths and unproven worktrees never read outside the named runtime', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.folder, 'outside.txt'), 'do-not-copy-into-state');
  const write = f.events.find(event => event.action === 'file_written' && event.agentId === 'developer');
  write.details.path = '../../../../outside.txt'; write.details.afterHash = hash('do-not-copy-into-state'); write.details.bytes = 22;
  const other = f.events.find(event => event.action === 'worktree_created' && event.agentId === 'docs'); other.details.path = f.folder;
  await f.save();
  const result = await recoverHistory(f.runtime, { backupDirectory: f.backup });
  assert.equal(result.filesRecovered, 4); assert.equal(result.skippedFiles.length, 2);
  assert.ok(!(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8')).includes('do-not-copy-into-state'));
});

test('backup path must be a new explicitly named sibling; existing backups are never overwritten', async () => {
  const f = await fixture(), before = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8');
  for (const backupDirectory of [f.runtime, path.join(f.runtime, 'nested'), path.join(f.folder, 'arbitrary')]) await assert.rejects(() => recoverHistory(f.runtime, { backupDirectory }), e => e.code === 'unsafe_backup');
  await fs.mkdir(f.backup); await fs.writeFile(path.join(f.backup, 'keep.txt'), 'existing backup');
  await assert.rejects(() => recoverHistory(f.runtime, { backupDirectory: f.backup }), e => e.code === 'backup_exists');
  assert.equal(await fs.readFile(path.join(f.backup, 'keep.txt'), 'utf8'), 'existing backup');
  assert.equal(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), before);
});

test('live runtime owner and concurrent recovery locks block changes', async () => {
  const f = await fixture(), before = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8');
  await fs.writeFile(path.join(f.runtime, 'chatgpt-owner.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(() => recoverHistory(f.runtime), e => e.code === 'runtime_active');
  await fs.unlink(path.join(f.runtime, 'chatgpt-owner.lock'));
  await fs.writeFile(path.join(f.folder, '.workspace.history-recovery.lock'), 'owned by fixture');
  await assert.rejects(() => recoverHistory(f.runtime), e => e.code === 'recovery_busy');
  assert.equal(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), before);
});

test('unsupported or malformed state, malformed audit, and credential fields fail before backup or write', async () => {
  for (const scenario of ['version', 'state-json', 'audit-json', 'credential']) {
    const f = await fixture();
    if (scenario === 'version') { f.state.version = 7; await f.save(); }
    if (scenario === 'state-json') await fs.writeFile(path.join(f.runtime, 'state.json'), '{invalid');
    if (scenario === 'audit-json') await fs.appendFile(path.join(f.runtime, 'audit.jsonl'), '{invalid\n');
    if (scenario === 'credential') { f.state.config.apiKey = 'synthetic-secret'; await f.save(); }
    const before = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8');
    await assert.rejects(() => recoverHistory(f.runtime));
    assert.equal(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), before);
    assert.deepEqual(await fs.readdir(f.folder), ['workspace']);
  }
});

test('duplicate conflicting audit IDs and hard-linked runtime files block recovery', async () => {
  const f = await fixture(), before = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8');
  f.events.push({ ...f.events[0], action: 'different-action' }); await f.save();
  await assert.rejects(() => recoverHistory(f.runtime), e => e.code === 'conflicting_audit');
  f.events.pop(); await f.save();
  await fs.link(path.join(f.runtime, 'state.json'), path.join(f.folder, 'linked-state.json'));
  await assert.rejects(() => recoverHistory(f.runtime), e => e.code === 'unsafe_runtime');
  assert.equal(await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8'), before);
});

test('unknown provider endpoints and tokens in audit configuration are never activated or copied', async () => {
  const f = await fixture();
  f.events[0].details.providers[0].apiKey = 'synthetic-audit-secret';
  f.events[0].details.providers[0].baseUrl = 'https://unverified.example.invalid';
  await f.save(); await recoverHistory(f.runtime, { backupDirectory: f.backup });
  const restored = await fs.readFile(path.join(f.runtime, 'state.json'), 'utf8');
  assert.ok(!restored.includes('synthetic-audit-secret'));
  assert.ok(!restored.includes('unverified.example.invalid'));
  assert.deepEqual(JSON.parse(restored).config.providers, []);
});
