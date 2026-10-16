import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash, safePath, isWithin } from '../lib/safety.mjs';

const STAGES = [
  ['orchestrator', '需求拆解', []], ['context', '代码库检索', ['orchestrator']], ['architect', '架构与风险设计', ['orchestrator']],
  ['developer', '开发交付', ['context', 'architect']], ['tester', '生成并执行测试', ['developer']], ['docs', '同步文档', ['developer']],
  ['regression', '原始需求验收', ['tester', 'docs']], ['git', 'Git 变更清单', ['regression']],
];
const error = (message, code) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 20000) => typeof value === 'string' && value.length <= limit && !value.includes('\0');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const tokenField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|client[_-]?secret|credentials?)$/i;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const slash = value => String(value).replaceAll('\\', '/');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

async function optional(file) { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function hasCredentialFields(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (tokenField.test(key) && item) || hasCredentialFields(item));
}
function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !tokenField.test(key)).map(([key, item]) => [key, sanitized(item)]));
}
function parseState(raw) {
  if (raw === null) return { version: 1, config: { projectPath: '', providers: [], agentProviders: {} }, jobs: [], analyses: [], skills: [], approvals: [] };
  let state; try { state = JSON.parse(raw); } catch { throw error('现有 state.json 无法解析；保留原文件，不能以恢复脚本覆盖。', 'invalid_state'); }
  if (!object(state) || state.version !== 1 || !object(state.config) || !Array.isArray(state.jobs) || !Array.isArray(state.approvals)) throw error('现有 state.json 版本或结构不兼容，已停止恢复。', 'invalid_state');
  if (state.jobs.length) throw error('现有工作区已有任务，拒绝覆盖。请在副本中核对恢复内容。', 'existing_jobs');
  if (hasCredentialFields(state)) throw error('现有状态含凭据字段，脚本不会将凭据写入恢复状态。', 'credentials_in_state');
  return state;
}
function parseAudit(raw) {
  if (!raw || Buffer.byteLength(raw) > 50000000) throw error('审计记录缺失或超出 50 MB 上限。', 'invalid_audit');
  const seen = new Map(), events = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { throw error(`审计记录第 ${index + 1} 行无效，已停止恢复。`, 'invalid_audit'); }
    if (!object(event) || !timestamp(event.at) || !text(event.action, 120) || !object(event.details)) throw error(`审计记录第 ${index + 1} 行缺少有效字段。`, 'invalid_audit');
    if (typeof event.id === 'string') {
      if (seen.has(event.id)) { if (seen.get(event.id) !== hash(event)) throw error('审计中同一事件编号出现不同内容。', 'conflicting_audit'); continue; }
      seen.set(event.id, hash(event));
    }
    events.push(event);
  }
  return events;
}
function configurationAt(events, createdIndex) {
  const event = events.slice(0, createdIndex + 1).findLast(item => item.action === 'configuration_updated');
  if (!event) return null;
  const details = event.details;
  // Audit does not always record endpoint/name. Preserve only what it actually
  // contains and never infer a usable endpoint from the service name.
  return { recordedAt: event.at, projectPath: typeof details.projectPath === 'string' ? details.projectPath : '', providers: (Array.isArray(details.providers) ? details.providers : []).map(item => Object.fromEntries(['id', 'name', 'type', 'model'].filter(key => text(item?.[key], 300)).map(key => [key, item[key]]))), agentProviders: object(details.agentProviders) ? Object.fromEntries(Object.entries(details.agentProviders).filter(([agent, id]) => STAGES.some(([stage]) => stage === agent) || agent === 'sandbox').filter(([, id]) => text(id, 100))) : {}, endpointNotRecovered: true, credentialsNotRecovered: true };
}

async function assertInactive(runtime) {
  const raw = await optional(path.join(runtime, 'chatgpt-owner.lock'));
  if (!raw) return;
  let owner; try { owner = JSON.parse(raw); } catch { throw error('运行锁无法核验，请先关闭共鸣并检查锁文件。', 'runtime_active'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error('运行锁无法核验，请先关闭共鸣。', 'runtime_active');
  try { process.kill(owner.pid, 0); throw error('共鸣后端仍在运行，请完全退出桌面软件后恢复。', 'runtime_active'); }
  catch (e) { if (e.code !== 'ESRCH') throw e.code === 'runtime_active' ? e : error('无法确认后端已停止，恢复已取消。', 'runtime_active'); }
}
async function verifyTree(directory) {
  // Do not follow junctions, symlinks, or hard links into other locations while
  // making the complete local backup. Copy ordinary files, including Git data.
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw error('恢复目录必须是普通目录，不能是链接。', 'unsafe_runtime');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw error('工作区包含符号链接或硬链接，请先在副本中核对，恢复已停止。', 'unsafe_runtime');
    if (stat.isDirectory()) await verifyTree(absolute);
    else if (!stat.isFile()) throw error('工作区包含非常规文件，恢复已停止。', 'unsafe_runtime');
  }
}

async function buildHistory(runtime, events, recoveredAt) {
  const starts = events.map((event, index) => ({ event, index })).filter(({ event }) => event.action === 'job_created');
  if (!starts.length) throw error('审计中没有可证明的任务创建记录。', 'no_jobs');
  const jobs = [], approvals = [], issues = [], identifiers = new Set();
  for (const { event: created, index } of starts) {
    const details = created.details, jobId = created.jobId;
    if (!/^job-[A-Za-z0-9-]{1,100}$/.test(jobId) || identifiers.has(jobId) || !text(details.brief) || !details.brief.trim() || !text(details.kind, 100) || !/^[0-9a-f]{40,64}$/i.test(details.baseCommit) || !text(details.projectPath, 2000) || !path.isAbsolute(details.projectPath) || !numeric(details.budget)) throw error('任务创建记录不完整或重复，无法可靠重建。', 'invalid_job');
    identifiers.add(jobId);
    const own = events.filter(item => item.jobId === jobId), fileEvents = new Map(), approvalMap = new Map();
    const job = { id: jobId, brief: details.brief, kind: details.kind, managedWorkspace: details.managedWorkspace === true, approvalMode: 'ask', status: 'paused', historicalStatus: 'unknown', recoveryIncomplete: true, recoveredAt, createdAt: created.at, updatedAt: own.at(-1)?.at || created.at, projectPath: details.projectPath, baseCommit: details.baseCommit, budget: details.budget, tokens: { reserved: 0, input: 0, output: 0, usageIncomplete: true }, tasks: STAGES.map(([id, title, deps]) => ({ id, agentId: id, title, deps: [...deps], status: deps.length ? 'blocked' : 'interrupted', historicalStatus: deps.length ? 'blocked' : 'queued', result: null, error: null, files: [], recoveryIncomplete: true })), artifacts: [], summary: '从审计和校验通过的文件恢复的历史任务。原模型回复未保留，不能继续执行；可查看和下载已有成果。', attempts: 0, configSnapshot: { providers: [], agentProviders: {} }, recovery: { source: 'audit-and-verified-files', readOnly: true, originalResultsUnavailable: true, configuration: configurationAt(events, index), issues: [], auditEvents: own.length, lastAuditAt: own.at(-1)?.at || created.at } };
    const taskFor = id => job.tasks.find(task => task.id === id);
    for (const item of own) {
      const task = taskFor(item.agentId), record = item.details;
      if (item.action === 'task_started' && task) { task.startedAt = item.at; task.historicalStatus = 'running'; if (text(record.title, 300)) task.title = record.title; }
      if (item.action === 'task_finished' && task && ['completed', 'awaiting_approval', 'failed', 'interrupted'].includes(record.status)) { task.historicalStatus = record.status; task.completedAt = item.at; }
      if (item.action === 'task_failed' && task) { task.historicalStatus = 'failed'; task.error = text(record.error) ? record.error : '审计记录表明此阶段失败。'; }
      if (item.action === 'worktree_created' && task) {
        const expected = path.join(runtime, 'worktrees', jobId, task.id);
        if (text(record.path, 2000) && samePath(record.path, expected)) { task.worktree = expected; if (text(record.branch, 300)) task.branch = record.branch; }
        else job.recovery.issues.push({ type: 'unverified_worktree', agentId: task.id });
      }
      if (item.action === 'file_written' && task && text(record.path, 500)) fileEvents.set(`${task.id}\0${slash(record.path)}`, item);
      if (item.action === 'model_request' && numeric(record.estimatedTokens)) job.tokens.reserved += record.estimatedTokens;
      if (item.action === 'model_response') { if (numeric(record.usage?.input)) job.tokens.input += record.usage.input; if (numeric(record.usage?.output)) job.tokens.output += record.usage.output; }
      if (item.action === 'approval_requested') {
        if (!/^approval-[A-Za-z0-9-]{1,100}$/.test(record.id) || approvalMap.has(record.id) || !['sandbox', 'commit', 'merge', 'rollback'].includes(record.type) || !task) { job.recovery.issues.push({ type: 'unverified_approval', agentId: item.agentId }); continue; }
        approvalMap.set(record.id, { id: record.id, jobId, taskId: task.id, type: record.type, title: text(record.title, 500) ? record.title : '历史审批', status: 'cancelled', historicalStatus: 'pending', details: sanitized(object(record.details) ? record.details : {}), action: null, createdAt: item.at, recoveryIncomplete: true, recoveredAt, replayDisabled: true, result: { recoveryNote: '仅恢复审批历史；未完成审批已取消，不能重放。' } });
        task.approvalId = record.id;
      }
      if (item.action === 'approval_decided' && approvalMap.has(record.id)) { const approval = approvalMap.get(record.id); approval.historicalStatus = record.approved === true ? 'running' : 'rejected'; approval.decidedAt = item.at; }
      if (item.action === 'approved_action_failed' && approvalMap.has(record.id)) {
        const approval = approvalMap.get(record.id); approval.historicalStatus = 'failed'; approval.completedAt = item.at;
        approval.result.error = text(record.error) ? record.error : '历史动作失败';
        if (approval.type === 'sandbox') { const target = taskFor(approval.taskId); target.historicalStatus = 'failed'; target.error = approval.result.error; }
      }
      if (item.action === 'approved_action_completed' && approvalMap.has(record.id)) { const approval = approvalMap.get(record.id); approval.historicalStatus = 'approved'; approval.completedAt = item.at; approval.result.recordedResult = sanitized(record.result || {}); if (approval.type === 'sandbox') taskFor(approval.taskId).historicalStatus = 'completed'; }
    }
    for (const item of fileEvents.values()) {
      const task = taskFor(item.agentId), record = item.details;
      const omitted = reason => { const issue = { type: 'file_not_recovered', agentId: task.id, path: slash(record.path), reason }; job.recovery.issues.push(issue); issues.push({ jobId, ...issue }); };
      if (!task.worktree || !text(record.worktree, 2000) || !samePath(record.worktree, task.worktree) || !/^[0-9a-f]{64}$/i.test(record.afterHash)) { omitted('缺少可校验的来源工作树或 SHA-256'); continue; }
      try {
        const absolute = await safePath(task.worktree, slash(record.path));
        const stat = await fs.lstat(absolute); if (!stat.isFile() || stat.size > 350000) { omitted('文件类型或大小超出安全范围'); continue; }
        const bytes = await fs.readFile(absolute), content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes) || hash(content) !== record.afterHash.toLowerCase() || (numeric(record.bytes) && record.bytes !== bytes.length)) { omitted('当前文件与审计哈希或字节数不一致'); continue; }
        task.files.push({ path: slash(record.path), content, hash: record.afterHash.toLowerCase(), agentId: task.id, recovered: true });
      } catch { omitted('文件缺失、受限制或无法安全读取'); }
    }
    for (const task of job.tasks) {
      task.status = ['completed', 'failed', 'blocked'].includes(task.historicalStatus) ? task.historicalStatus : 'interrupted';
      if (task.startedAt || task.files.length) task.result = { summary: '历史阶段记录已恢复；原模型回复未保留。这里的说明不是原分析结果。', recoveryIncomplete: true, originalResultUnavailable: true, files: task.files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content) })) };
      if (['pending', 'running', 'awaiting_approval'].includes(task.historicalStatus)) task.error = task.error || '恢复后已暂停；历史中未完成的操作不能重放。';
      job.artifacts.push(...task.files);
    }
    for (const approval of approvalMap.values()) { approval.status = ['approved', 'failed', 'rejected'].includes(approval.historicalStatus) ? approval.historicalStatus : 'cancelled'; approvals.push(approval); }
    const lastPauseOrResume = own.findLast(item => ['job_paused', 'job_resumed'].includes(item.action));
    job.historicalStatus = lastPauseOrResume?.action === 'job_paused' ? 'paused' : job.tasks.every(task => task.historicalStatus === 'completed') ? 'completed' : job.tasks.some(task => task.historicalStatus === 'awaiting_approval') ? 'awaiting_approval' : job.tasks.some(task => task.historicalStatus === 'failed') ? 'failed' : 'incomplete';
    jobs.push(job);
  }
  jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { jobs, approvals, issues };
}

/** Recover review-only history. Never call this while a backend is running. */
export async function recoverHistory(runtimeDirectory, { backupDirectory } = {}) {
  if (typeof runtimeDirectory !== 'string' || !runtimeDirectory.trim()) throw error('请明确指定要恢复的 runtime 目录。', 'invalid_runtime');
  const runtime = path.resolve(runtimeDirectory), parent = path.dirname(runtime), name = path.basename(runtime);
  if (runtime === path.parse(runtime).root) throw error('不能恢复磁盘根目录。', 'invalid_runtime');
  await assertInactive(runtime);
  const stateFile = path.join(runtime, 'state.json'), auditFile = path.join(runtime, 'audit.jsonl');
  const originalState = await optional(stateFile), originalAudit = await optional(auditFile), state = parseState(originalState), events = parseAudit(originalAudit);
  await verifyTree(runtime);
  const recoveredAt = new Date().toISOString(), history = await buildHistory(runtime, events, recoveredAt);
  const stamp = recoveredAt.replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  const backup = backupDirectory ? path.resolve(backupDirectory) : path.join(parent, `${name}-recovery-backup-${stamp}-${crypto.randomUUID().slice(0,8)}`);
  if (!samePath(path.dirname(backup), parent) || samePath(backup, runtime) || !path.basename(backup).startsWith(`${name}-recovery-backup-`) || isWithin(runtime, backup)) throw error(`备份目录必须是同级目录，名称以 ${name}-recovery-backup- 开头。`, 'unsafe_backup');
  if (await fs.lstat(backup).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw error('备份目录已经存在，拒绝覆盖。', 'backup_exists');
  const lockFile = path.join(parent, `.${name}.history-recovery.lock`);
  let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw error('另一个恢复进程正在运行，已停止。', 'recovery_busy'); throw e; }
  let temporary;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, runtime, recoveredAt }));
    await assertInactive(runtime);
    if (await optional(stateFile) !== originalState || await optional(auditFile) !== originalAudit) throw error('恢复期间工作区发生变化，已停止。', 'source_changed');
    await fs.cp(runtime, backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false });
    if (await optional(path.join(backup, 'state.json')) !== originalState || await optional(path.join(backup, 'audit.jsonl')) !== originalAudit) throw error('备份与原始记录不一致，原状态未修改。', 'backup_mismatch');
    for (const job of history.jobs) for (const task of job.tasks) for (const file of task.files) {
      const relative = path.relative(runtime, path.join(task.worktree, file.path));
      if (!isWithin(runtime, path.join(runtime, relative)) || hash(await fs.readFile(path.join(backup, relative), 'utf8')) !== file.hash || hash(await fs.readFile(path.join(runtime, relative), 'utf8')) !== file.hash) throw error('成果在恢复过程中发生变化，原状态未修改。', 'source_changed');
    }
    const existingApprovalIds = new Set(state.approvals.map(item => item.id));
    if (history.approvals.some(item => existingApprovalIds.has(item.id))) throw error('现有审批记录与待恢复历史重复，原状态未修改。', 'existing_approvals');
    const next = { ...state, jobs: history.jobs, approvals: [...state.approvals, ...history.approvals], analyses: state.analyses || [], skills: state.skills || [], recovery: { recoveredAt, backupDirectory: backup, source: 'audit-and-verified-files', incomplete: true } };
    temporary = path.join(runtime, `state.recovery-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(next, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await assertInactive(runtime);
    if (await optional(stateFile) !== originalState || await optional(auditFile) !== originalAudit) throw error('写入前检测到工作区变化，原状态未修改。', 'source_changed');
    await fs.rename(temporary, stateFile); temporary = null;
    return { runtime, backupDirectory: backup, jobsRecovered: history.jobs.length, filesRecovered: history.jobs.reduce((sum, job) => sum + job.artifacts.length, 0), approvalsRecovered: history.approvals.length, skippedFiles: history.issues, configurationActivated: false, recoveryIncomplete: true };
  } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); await lock.close(); await fs.unlink(lockFile).catch(() => {}); }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  try {
    if (!value('--runtime') || args.some((arg, index) => index % 2 === 0 && !['--runtime', '--backup'].includes(arg))) throw new Error('用法：node scripts/recover-history.mjs --runtime "绝对运行目录" [--backup "同级目录-recovery-backup-名称"]');
    console.log(JSON.stringify(await recoverHistory(value('--runtime'), { backupDirectory: value('--backup') }), null, 2));
  } catch (e) { console.error(JSON.stringify({ error: e.code || 'recovery_failed', message: e.message })); process.exitCode = 1; }
}
