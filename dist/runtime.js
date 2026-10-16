(function () {
  'use strict';

  // This panel only renders server state; no model progress or results are simulated.
  const state = { connected: false, status: null, tab: 'jobs', timer: null, loading: null, dialog: null, providerCounter: 0, providerPresets: [], pendingDraft: null, mutations: new Set() };
  const labels = { pending: '等待中', queued: '已排队', running: '运行中', completed: '已完成', succeeded: '已通过', success: '已通过', failed: '失败', paused: '已暂停', interrupted: '已中断', blocked: '等待依赖', waiting_approval: '待审批', awaiting_approval: '待审批', approved: '执行成功', rejected: '已拒绝', skipped: '已跳过', cancelled: '已取消', unknown: '状态待核实', ready: '已就绪', committed: '已提交', merged: '已合并', rolled_back: '已回滚' };
  const kinds = { auto: '自动识别', document: '文档', ppt: '演示文稿', website: '网站', code: '代码任务', project: '软件项目', work: '日常工作' };
  const presets = {
    ollama: { name: 'Ollama 本地', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
    openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
    deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
    anthropic: { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    gemini: { name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    qwen: { name: '通义千问 Qwen', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    moonshot: { name: 'Moonshot / Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
    zhipu: { name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    siliconflow: { name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
    lmstudio: { name: 'LM Studio 本地', type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
    custom: { name: '自定义服务', type: 'openai', baseUrl: '' }
  };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const list = value => Array.isArray(value) ? value : [];
  const json = value => typeof value === 'string' ? value : JSON.stringify(value == null ? {} : value, null, 2);
  const when = value => { const date = new Date(value); return value && !isNaN(date) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'; };
  const toast = message => window.Gongming && typeof window.Gongming.toast === 'function' ? window.Gongming.toast(message) : null;
  const credentialNote = () => state.status?.config?.credentialStorage === 'encrypted' ? '密钥由本机系统加密保存，重启后可继续使用。' : '密钥仅保存在本次运行的内存中，重启后需重新填写。';
  const statusBadge = value => `<span class="rt-status rt-status-${esc(value || 'pending')}">${esc(labels[value] || value || '等待中')}</span>`;
  const button = (label, action, id, primary, disabled) => `<button type="button" class="${primary ? 'primary-button' : 'outline-button'}" data-rt-action="${esc(action)}"${id ? ` data-id="${esc(id)}"` : ''}${disabled || state.mutations.has(id) ? ' disabled' : ''}>${esc(label)}</button>`;
  const empty = (title, description) => `<div class="rt-empty"><span class="rt-empty-mark">◇</span><strong>${esc(title)}</strong><p>${esc(description || '')}</p></div>`;

  async function api(path, body, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error(`服务未返回 JSON（HTTP ${response.status}）。请通过 npm start 启动本地服务后打开页面。`);
      const data = await response.json();
      if (!response.ok) {
        const detail = typeof data.error === 'string' ? data.error : data.error && data.error.message;
        throw new Error(data.message || detail || `请求失败（HTTP ${response.status}）`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，等待已结束。${body === undefined ? '请检查本地服务状态。' : '服务端可能仍在执行，请刷新确认结果，不要重复提交。'}`);
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function errorBox(container, message) {
    if (!container) { toast(message); return; }
    container.innerHTML = `<div class="rt-error" role="alert">${esc(message)}</div>`;
  }

  function root() {
    let element = document.getElementById('runtimeView');
    if (!element) {
      element = document.createElement('section');
      element.id = 'runtimeView';
      element.className = 'view';
      (document.getElementById('mainContent') || document.querySelector('main') || document.body).appendChild(element);
    }
    return element;
  }

  function taskComposer() {
    return `<div class="rt-section-top"><div><h2>今天想完成什么？</h2><p>描述你的目标，团队会安排合适的分工。</p></div></div><label class="field-label" for="rtBrief">任务目标</label><textarea id="rtBrief" name="brief" class="form-textarea" required minlength="3" maxlength="20000" placeholder="写一份产品介绍、做一套演示文稿，或为现有项目增加一个功能…"></textarea><details class="rt-advanced rt-task-advanced"><summary>高级设置 <span>类型、预算与代码项目</span></summary><div class="rt-settings-grid"><label>任务类型<select id="rtKind" name="kind" class="form-input"><option value="auto">自动识别</option><option value="document">文档</option><option value="ppt">演示文稿</option><option value="website">网站</option><option value="code">代码任务</option><option value="project">软件项目</option></select></label><label>Token 预算<input id="rtBudget" name="budget" type="number" class="form-input" min="2000" max="1000000" step="1000" value="100000" required></label><label class="rt-full">现有代码仓库路径（仅修改现有代码时需要）<input id="rtTaskProjectPath" name="projectPath" class="form-input" placeholder="已有 Git 仓库的绝对路径"></label></div><p class="rt-hint">文档、PPT 和新网站无需选择仓库。预算包含输入和输出，以服务商返回的实际用量为准。</p></details><div class="rt-composer-footer"><span id="rtModelHint" class="rt-hint">连接一个模型，就能开始。</span><button type="button" class="text-link" data-manage-models>添加 / 管理模型</button><button class="outline-button" type="button" data-requirements="task">先分析需求</button><button class="primary-button" type="submit">开始任务</button></div><div id="rtCreateError"></div>`;
  }

  function draftFromForm() {
    const form = document.getElementById('rtCreateForm');
    if (!form) return state.pendingDraft;
    const brief = form.elements.brief.value, kind = form.elements.kind.value;
    const analysisId = state.pendingDraft?.brief?.trim() === brief.trim() && state.pendingDraft?.kind === kind ? state.pendingDraft.analysisId : undefined;
    const workflow = state.pendingDraft?.kind === kind ? { workflowId: state.pendingDraft.workflowId, templateValues: state.pendingDraft.templateValues, libraryWorkflowId: state.pendingDraft.libraryWorkflowId } : {};
    return { brief, kind, analysisId, ...workflow, budget: Number(form.elements.budget.value) || 100000, projectPath: form.elements.projectPath.value };
  }

  function saveDraft(draft) {
    state.pendingDraft = draft;
    try { if (draft && draft.brief) sessionStorage.setItem('gongming:pending-task', JSON.stringify(draft)); else sessionStorage.removeItem('gongming:pending-task'); } catch (_) { /* Storage can be disabled in private mode. */ }
  }

  function restoreDraft(draft) {
    const form = document.getElementById('rtCreateForm');
    if (!draft || !form) return;
    form.elements.brief.value = draft.brief || '';
    form.elements.kind.value = Object.prototype.hasOwnProperty.call(kinds, draft.kind) && draft.kind !== 'work' ? draft.kind : 'auto';
    form.elements.budget.value = draft.budget || 100000;
    form.elements.projectPath.value = draft.projectPath || '';
  }

  function shell() {
    const element = root();
    if (element.dataset.rtMounted) return element;
    element.dataset.rtMounted = 'true';
    element.innerHTML = `<div class="page-heading rt-heading"><div><span class="rt-eyebrow">我的工作空间</span><h1>高级工作台</h1><p>协作看板、执行审批、技能与审计，集中查看。</p></div><div class="button-row">${button('刷新状态', 'refresh')}${button('连接模型', 'settings', '', true)}</div></div><div id="rtConnection" aria-live="polite"></div><div id="rtGlobalError"></div><div id="rtWorkspaceBody" hidden><div id="rtMetrics" class="rt-metrics"></div><div class="rt-tabs" role="tablist" aria-label="真实工作区"><button type="button" role="tab" id="rt-tab-jobs" aria-controls="rt-panel-jobs" data-rt-tab="jobs">协作看板</button><button type="button" role="tab" id="rt-tab-approvals" aria-controls="rt-panel-approvals" data-rt-tab="approvals">执行审批 <span id="rtApprovalCount"></span></button><button type="button" role="tab" id="rt-tab-artifacts" aria-controls="rt-panel-artifacts" data-rt-tab="artifacts">任务成果</button><button type="button" role="tab" id="rt-tab-skills" aria-controls="rt-panel-skills" data-rt-tab="skills">技能库</button><button type="button" role="tab" id="rt-tab-audit" aria-controls="rt-panel-audit" data-rt-tab="audit">审计日志</button></div><section id="rt-panel-jobs" data-rt-panel="jobs" role="tabpanel" aria-labelledby="rt-tab-jobs"><form id="rtCreateForm" class="rt-create">${taskComposer()}</form><div class="rt-section-top rt-list-heading"><h2>协作任务</h2><span id="rtPollNote" class="rt-hint"></span></div><div id="rtTaskList"></div></section><section id="rt-panel-approvals" data-rt-panel="approvals" role="tabpanel" aria-labelledby="rt-tab-approvals" hidden><div class="rt-section-top"><div><h2>执行前，由你确认</h2><p>先看要做什么、影响哪里，再决定是否同意。具体命令可按需展开。</p></div></div><div id="rtApprovalList"></div></section><section id="rt-panel-artifacts" data-rt-panel="artifacts" role="tabpanel" aria-labelledby="rt-tab-artifacts" hidden><div class="rt-section-top"><div><h2>任务成果</h2><p>内容来自本地服务返回，可查看文本与结果 JSON。</p></div></div><div id="rtArtifactList"></div></section><section id="rt-panel-skills" data-rt-panel="skills" role="tabpanel" aria-labelledby="rt-tab-skills" hidden><div class="rt-section-top"><div><h2>沉淀可复用的经验</h2><p>技能来自已通过真实回归验证的任务。</p></div></div><div id="rtSkillList"></div></section><section id="rt-panel-audit" data-rt-panel="audit" role="tabpanel" aria-labelledby="rt-tab-audit" hidden><div class="rt-section-top"><div><h2>每一步都有记录</h2><p>模型调用、任务状态和用户审批的本地记录。</p></div></div><div id="rtAuditList"></div><button type="button" class="outline-button" data-rt-action="audit-older">查看更早记录</button></section></div>`;
    const createForm = element.querySelector('#rtCreateForm');
    if (!state.pendingDraft) { try { state.pendingDraft = JSON.parse(sessionStorage.getItem('gongming:pending-task') || 'null'); } catch (_) {} }
    restoreDraft(state.pendingDraft);
    createForm.addEventListener('input', () => saveDraft(draftFromForm()));
    createForm.addEventListener('change', () => saveDraft(draftFromForm()));
    element.addEventListener('click', onClick);
    createForm.addEventListener('submit', createJob);
    selectTab(state.tab);
    return element;
  }

  function selectTab(tab) {
    state.tab = tab;
    root().querySelectorAll('[data-rt-tab]').forEach(element => {
      const selected = element.dataset.rtTab === tab;
      element.classList.toggle('selected', selected);
      element.setAttribute('aria-selected', String(selected));
    });
    root().querySelectorAll('[data-rt-panel]').forEach(element => { element.hidden = element.dataset.rtPanel !== tab; });
  }

  function preserveDetails(element, html) {
    if (!element) return;
    const opened = new Set([...element.querySelectorAll('details[open][data-detail-id]')].map(item => item.dataset.detailId));
    element.innerHTML = html;
    element.querySelectorAll('details[data-detail-id]').forEach(item => { if (opened.has(item.dataset.detailId)) item.open = true; });
  }

  function drawStatus() {
    const data = state.status;
    const jobs = list(data.jobs);
    const pending = list(data.approvals).filter(item => item.status === 'pending').length;
    const active = jobs.filter(item => ['running', 'queued'].includes(item.status)).length;
    const providers = list(data.config && data.config.providers);
    document.getElementById('rtConnection').innerHTML = `<div class="rt-connected"><span class="green-dot"></span><strong>工作区已就绪</strong><span>${providers.length ? `已配置 ${providers.length} 个模型连接` : '连接模型后即可开始'}</span></div>`;
    document.getElementById('rtWorkspaceBody').hidden = false;
    document.getElementById('rtMetrics').innerHTML = `<div><span>已配置模型</span><strong>${providers.length}<small>个连接</small></strong></div><div><span>正在协作</span><strong>${active}<small>个任务</small></strong></div><div><span>等待你审批</span><strong>${pending}<small>项操作</small></strong></div><div><span>已沉淀技能</span><strong>${list(data.skills).length}<small>项经验</small></strong></div>`;
    document.getElementById('rtApprovalCount').textContent = pending ? String(pending) : '';
    document.getElementById('rtPollNote').textContent = active ? '运行期间每 5 秒更新状态' : '状态已更新';
    document.getElementById('rtModelHint').textContent = data.capabilities && data.capabilities.model ? `总控：${window.TeamUI?.resolve(data.config,'orchestrator')?.name || '未分配'} · ${providers.length} 个模型`  : '首次使用：开始后先连接模型。';
    drawJobs(); drawApprovals(); drawArtifacts(); drawSkills(); drawAudit();
  }

  function taskCard(task, agents) {
    const agent = agents.find(item => item.id === task.agentId) || {};
    return `<div class="rt-agent-task"><div class="rt-agent-task-top"><span class="rt-agent-icon">${esc((agent.name || task.agentId || 'A').slice(0, 1))}</span>${statusBadge(task.status)}</div><strong>${esc(agent.name || task.agentId || task.title)}</strong><p>${esc(task.title || agent.role || '')}</p><span class="rt-deps">依赖：${esc(list(task.deps).join('、') || '无，可直接开始')}</span>${task.error ? `<p class="rt-task-error">${esc(json(task.error))}</p>` : ''}${task.worktree ? `<span class="rt-path" title="${esc(task.worktree)}">${esc(task.worktree)}</span>` : ''}${task.result ? `<details class="rt-result-details" data-detail-id="task-${esc(task.id)}"><summary>查看返回结果</summary><pre>${esc(json(task.result))}</pre></details>` : ''}</div>`;
  }

  function drawJobs() {
    const jobs = list(state.status.jobs);
    const agents = list(state.status.agents);
    const html = jobs.length ? jobs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(job => {
      const tokens = job.tokens || {};
      const tasks = list(job.tasks);
      const done = tasks.filter(task => ['completed', 'succeeded', 'success', 'skipped'].includes(task.status)).length;
      const gitReady = !job.recoveryIncomplete && job.worktree && tasks.some(task => task.id === 'git' && task.status === 'completed');
      const actions = [
        ['running', 'queued'].includes(job.status) ? button('暂停', 'pause', job.id) : '',
        !job.recoveryIncomplete && ['paused', 'failed', 'interrupted', 'blocked'].includes(job.status) ? button('继续', 'resume', job.id) : '',
        !job.recoveryIncomplete && ['failed', 'interrupted', 'blocked', 'paused'].includes(job.status) ? button('重试', 'retry', job.id) : '',
        ['waiting_approval', 'awaiting_approval'].includes(job.status) ? button('查看审批', 'show-approvals', job.id, true) : '',
        button(job.commit ? '已提交' : '提交变更', 'commit', job.id, false, !gitReady || !!job.commit),
        button(job.mergedCommit ? '已合并' : '合并', 'merge', job.id, false, !job.commit || !!job.mergedCommit),
        button(job.rollbackCommit ? '已回滚' : '回滚', 'rollback', job.id, false, !job.commit || !!job.rollbackCommit),
        button('完整记录', 'job-detail', job.id)
      ].join('');
      return `<article class="rt-job"><div class="rt-job-top"><div><span class="rt-eyebrow">${esc(kinds[job.kind] || job.kind || '协作任务')} · ${esc(job.id)}</span><h3>${esc(job.brief || '未命名任务')}</h3></div>${statusBadge(job.status)}</div><div class="rt-job-meta"><span>创建于 ${esc(when(job.createdAt))}</span><span>进度 ${done} / ${tasks.length}</span><span>${tokens.usageIncomplete ? '已报告' : ''}输入 ${Number(tokens.input || 0).toLocaleString()} / 输出 ${Number(tokens.output || 0).toLocaleString()} tokens</span><span>预算 ${Number(job.budget || 0).toLocaleString()} · 预留 ${Number(tokens.reserved || 0).toLocaleString()}</span></div>${tokens.usageIncomplete ? '<p class="rt-hint">部分模型未返回完整用量，以上数字不代表全部实际消耗。</p>' : ''}<div class="rt-progress"><span style="width:${tasks.length ? Math.round(done / tasks.length * 100) : 0}%"></span></div>${window.WorkflowsUI?.progress?.(job) || ''}${job.error ? `<div class="rt-error">${esc(json(job.error))}</div>` : ''}<div class="rt-job-actions">${window.WorkflowsUI?.resultButton?.(job) || ''}${actions}</div><details class="rt-job-details" data-detail-id="job-${esc(job.id)}"${['running', 'failed', 'interrupted', 'paused', 'blocked'].includes(job.status) ? ' open' : ''}><summary>查看 Agent 分工与依赖 <span>${tasks.length} 个步骤</span></summary><div class="rt-agent-grid">${tasks.length ? tasks.map(task => taskCard(task, agents)).join('') : '<p class="rt-hint">服务尚未返回任务步骤。</p>'}</div>${job.summary ? `<div class="rt-summary"><strong>任务总结</strong><pre>${esc(json(job.summary))}</pre></div>` : ''}${job.branch ? `<p class="rt-hint">工作分支：<code>${esc(job.branch)}</code> · 基线：<code>${esc(job.baseCommit || '—')}</code></p>` : ''}</details></article>`;
    }).join('') : empty('还没有任务', '连接模型并填写目标，让团队开始第一项工作。');
    const roster = agents.length ? `<details class="rt-roster rt-advanced" data-detail-id="roster"><summary>团队分工 <span>${agents.length} 个角色协同完成</span></summary><div class="rt-roster-grid">${agents.map(agent => `<div><span>${esc((agent.name || agent.id).slice(0, 1))}</span><strong>${esc(agent.name || agent.id)}</strong><small>${esc(agent.role || agent.id)}</small></div>`).join('')}</div></details>` : '';
    preserveDetails(document.getElementById('rtTaskList'), roster + html);
  }

  function drawApprovals() {
    const approvals = list(state.status.approvals).slice().reverse();
    preserveDetails(document.getElementById('rtApprovalList'), approvals.length ? approvals.map(item => {
      const info=window.ApprovalUI.describe(item),job=list(state.status.jobs).find(job=>job.id===item.jobId);
      return `<article class="rt-approval"><div class="rt-job-top"><div><span class="rt-eyebrow">${esc(info.label)} · ${esc(job?.brief || item.jobId || '')}</span><h3>${esc(info.title)}</h3></div>${statusBadge(item.status)}</div>${window.ApprovalUI.body(item)}${item.result ? `<details data-detail-id="approval-${esc(item.id)}"><summary>执行结果</summary><pre>${esc(json(item.result))}</pre></details>` : ''}<div class="rt-approval-bottom"><span>${esc(when(item.createdAt))}</span>${item.status === 'pending' ? `<div class="button-row">${button(info.reject, 'reject', item.id)}${button(info.approve, 'approve', item.id, true)}</div>` : ''}</div></article>`;
    }).join('') : empty('当前没有待审批操作', '需要运行测试或修改项目版本时，这里会说明影响并请你确认。'));
  }

  function drawArtifacts() {
    const records = list(state.status.jobs).flatMap(job => list(job.artifacts).map((artifact, index) => ({ job, artifact, index })));
    preserveDetails(document.getElementById('rtArtifactList'), records.length ? records.slice().reverse().map(({ job, artifact, index }) => `<article class="rt-artifact"><div class="rt-job-top"><div><span class="rt-eyebrow">${esc(job.id)} · ${esc(artifact.agentId || '团队产出')}</span><h3>${esc(artifact.path || artifact.name || `交付物 ${index + 1}`)}</h3></div>${button('下载文本', 'download-artifact', `${job.id}:${index}`)}</div><p class="rt-hint">${artifact.hash ? `内容校验 ${esc(artifact.hash)}` : '内容来自本地任务记录'}</p><details data-detail-id="artifact-${esc(job.id)}-${index}"><summary>查看内容</summary><pre class="rt-content-preview">${esc(artifact.content === undefined ? json(artifact) : json(artifact.content))}</pre></details></article>`).join('') : empty('完成的作品会出现在这里', '任务生成的文件和内容会保存在这里。'));
  }

  function drawSkills() {
    const skills = list(state.status.skills).slice().reverse();
    document.getElementById('rtSkillList').innerHTML = skills.length ? `<div class="rt-skill-grid">${skills.map(skill => `<article class="rt-skill"><span class="rt-skill-mark">✧</span><h3>${esc(skill.name || skill.id)}</h3><p>${esc(skill.summary || '')}</p><small>来源任务 ${esc(skill.sourceJobId || '—')}</small><small>${esc(when(skill.createdAt))}</small></article>`).join('')}</div>` : empty('经验需要真实验证', '任务通过回归后，可复用的经验会自动进入技能库。');
  }

  function drawAudit() {
    const combined=[...new Map([...list(state.olderAudit),...list(state.status.audit)].map(item=>[item.id,item])).values()];const records=combined.slice().reverse();state.auditCursor=combined[0]?.id;
    const actions = {task_started:'开始执行步骤',task_finished:'步骤已完成',task_failed:'步骤执行失败',file_written:'已更新文件',approval_requested:'等待你的审批',approval_decided:'已记录审批决定',approval_auto_decided:'已按授权规则审批',approved_action_failed:'审批后的操作失败',approved_action_completed:'审批后的操作完成',model_request:'正在请求模型',model_response:'已收到模型结果',model_cache_hit:'复用已有模型结果',agent_tool_finished:'Agent 已完成工具步骤',worktree_created:'已建立独立工作区',context_read:'已读取项目上下文',configuration_updated:'已保存模型与项目设置',provider_connected:'模型连接成功',job_created:'任务已创建',job_paused:'任务已暂停',job_resumed:'任务已继续',command_started:'开始执行命令',command_finished:'命令执行结束',git_command:'执行版本管理操作',container_cleanup:'清理任务容器',repair_requested:'已安排修复问题',skill_saved:'已保存成功经验',requirements_analysis_started:'开始分析需求',requirements_analysis_completed:'需求分析完成',requirements_analysis_failed:'需求分析失败',requirements_analysis_reused:'沿用已确认的需求方案',workflow_artifact_validated:'成果结构检查完成',review_comment:'已添加审阅意见',review_resolve:'已更新意见处理状态','review_edit-slide':'已保存作品新版本',review_approve:'作品已确认定稿'};
    preserveDetails(document.getElementById('rtAuditList'), records.length ? `<div class="rt-audit">${records.map(record => {
      const agent=list(state.status.agents).find(item=>item.id===record.agentId);
      const actor=agent?.name || (record.agentId==='user'?'你':record.agentId?'协作成员':'系统');
      const job=list(state.status.jobs).find(item=>item.id===record.jobId);
      const context=job?.brief?.slice(0,65) || (record.jobId?'任务记录':'工作区');
      return `<article><div class="rt-audit-dot"></div><div><div class="rt-audit-top"><strong>${esc(actions[record.action] || '工作记录')}</strong><time>${esc(when(record.at))}</time></div><span class="rt-hint">${esc(context)} / ${esc(actor)}</span><details data-detail-id="audit-${esc(record.id)}"><summary>查看详细记录</summary><pre>${esc(json({事件类型:record.action,任务编号:record.jobId,执行者编号:record.agentId,详情:record.details}))}</pre></details></div></article>`;
    }).join('')}</div>` : empty('暂无审计记录', '模型配置、任务运行与审批操作会留下记录。'));
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const active = state.connected && (list(state.status && state.status.jobs).some(job => ['running', 'queued'].includes(job.status)) || list(state.status && state.status.approvals).some(approval => approval.status === 'running'));
    if (active) state.timer = setTimeout(() => refresh(), 5000);
  }

  async function refresh() {
    shell();
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        const data = await api('/api/status');
        if (!data || data.mode !== 'local') throw new Error('此页面未连接Resonance本地服务。');
        state.status = data; state.connected = true;
        document.getElementById('rtGlobalError').innerHTML = '';
        drawStatus();
        return data;
      } catch (error) {
        state.connected = false;
        document.getElementById('rtConnection').innerHTML = `<div class="rt-offline"><span class="rt-offline-icon">↗</span><div><strong>当前是静态演示，真实服务尚未连接</strong><p>下载完整项目，在项目目录执行 <code>npm start</code>，再打开终端显示的本地地址。仅托管静态页面无法访问模型或项目文件。</p><p class="rt-offline-detail">${esc(error.message)}</p></div>${button('重新连接', 'refresh')}</div>`;
        document.getElementById('rtWorkspaceBody').hidden = !state.status;
        if (state.status) errorBox(document.getElementById('rtGlobalError'), `连接已中断，以下为上次获取的记录：${error.message}`);
        return null;
      } finally { state.loading = null; schedulePoll(); }
    })();
    return state.loading;
  }

  async function render() {
    shell();
    document.getElementById('rtConnection').innerHTML = '<div class="rt-connecting">正在连接本地工作区…</div>';
    return refresh();
  }

  async function startTask(options = {}) {
    if (state.launching) return;
    state.launching = true;
    try {
      shell();
      saveDraft({ ...draftFromForm(), ...options, kind: options.kind || 'auto', budget: options.budget || 100000 });
      restoreDraft(state.pendingDraft);
      selectTab('jobs');
      if (window.Gongming && typeof window.Gongming.openView === 'function') window.Gongming.openView('runtime');
      await refresh();
      const form = document.getElementById('rtCreateForm');
      if (form.reportValidity()) return await createJob({ currentTarget: form, preventDefault() {} });
    } finally { state.launching = false; }
  }

  async function createJob(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    const error = document.getElementById('rtCreateError');
    const draft = draftFromForm();
    saveDraft(draft);
    if (!state.connected) { errorBox(error, '本地服务未连接，请先启动本地服务。你的任务目标已保留。'); return; }
    const brief = draft.brief.trim();
    if (brief.length < 3) { errorBox(error, '请填写至少 3 个字符的任务目标。'); return; }
    if (!state.status.capabilities || !state.status.capabilities.model) { await openSettings(); return; }
    const projectPath = draft.projectPath.trim();
    if (draft.kind === 'code' && !projectPath && !(state.status.config && state.status.config.projectPath)) {
      form.querySelector('.rt-task-advanced').open = true;
      errorBox(error, '代码任务需要一个已有 Git 仓库。填写项目路径后即可开始，任务目标已保留。');
      form.elements.projectPath.focus();
      return;
    }
    submit.disabled = true; submit.textContent = '正在开始…'; error.innerHTML = '';
    try {
      if (projectPath && projectPath !== (state.status.config && state.status.config.projectPath)) {
        if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(projectPath)) throw new Error('请输入项目的绝对路径。');
        await api('/api/config', { projectPath });
      }
      const data = await api('/api/jobs', { brief, kind: draft.kind || 'auto', budget: draft.budget || 100000, ...(draft.analysisId ? {analysisId:draft.analysisId} : {}), ...(draft.workflowId ? {workflowId:draft.workflowId, templateValues:draft.templateValues || {}} : {}), ...(draft.libraryWorkflowId ? {libraryWorkflowId:draft.libraryWorkflowId} : {}) });
      form.elements.brief.value = '';
      saveDraft(null);
      toast('任务已开始');
      await refresh();
      window.WorkflowsUI?.onTaskCreated?.(data.job);
      try { await window.ChatUI?.attachJob?.(data.job); window.Gongming?.openView('chat'); } catch { toast('任务已创建，可在详细工作记录中继续查看。'); }
    } catch (failure) {
      errorBox(error, `${failure.message} 任务目标已保留。`);
      if (/configuration_required|API Key|模型.*配置|配置.*模型/i.test(failure.message)) await openSettings();
      else if (/project_required|Git.*仓库|仓库.*Git/i.test(failure.message)) { form.querySelector('.rt-task-advanced').open = true; form.elements.projectPath.focus(); }
    }
    finally { submit.disabled = false; submit.textContent = '开始任务'; }
  }

  async function onClick(event) {
    const tab = event.target.closest('[data-rt-tab]');
    if (tab) { selectTab(tab.dataset.rtTab); return; }
    const target = event.target.closest('[data-rt-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.rtAction;
    const id = target.dataset.id;
    if(action==='audit-older'){const cursor=state.auditCursor;if(!cursor)return;target.disabled=true;try{const page=await api('/api/audit?before='+encodeURIComponent(cursor)+'&limit=100');state.olderAudit=[...list(page.items),...list(state.olderAudit)];drawAudit();if(!page.hasMore){target.textContent='已显示全部历史';target.disabled=true;}}catch(error){toast(error.message);}finally{if(target.textContent!=='已显示全部历史')target.disabled=false;}return;}
    if (action === 'settings') { await openSettings(); return; }
    if (action === 'refresh') { await refresh(); return; }
    if (action === 'download-artifact') { downloadArtifact(id); return; }
    if (action === 'job-detail') { await showJob(id); return; }
    if (action === 'show-approvals') { selectTab('approvals'); return; }
    if (!state.connected) { errorBox(document.getElementById('rtGlobalError'), '连接已中断，请重新连接后再操作。'); return; }
    if (state.mutations.has(id)) return;
    state.mutations.add(id);
    target.disabled = true;
    target.closest('.rt-job-actions, .rt-approval')?.querySelectorAll('[data-rt-action]').forEach(item => { item.disabled = true; });
    document.getElementById('rtGlobalError').innerHTML = '';
    let failureMessage = '';
    try {
      if (action === 'approve' || action === 'reject') {
        await api(`/api/approvals/${encodeURIComponent(id)}`, { approved: action === 'approve' }, 180000);
        toast(action === 'approve' ? '审批已提交，执行结果以服务记录为准' : '已拒绝操作');
      } else if (['pause', 'resume', 'retry', 'commit', 'merge', 'rollback'].includes(action)) {
        const data = await api(`/api/jobs/${encodeURIComponent(id)}/actions`, { action });
        if (data.approval) { selectTab('approvals'); toast('请查看具体操作并审批'); }
        else toast('操作已提交');
      }
    } catch (error) { failureMessage = error.message; }
    finally {
      state.mutations.delete(id);
      await refresh();
      if (failureMessage) errorBox(document.getElementById('rtGlobalError'), failureMessage);
      if (target.isConnected) target.disabled = false;
    }
  }

  function dialog(title, subtitle, body) {
    if (state.dialog) { state.dialog.close(); state.dialog.remove(); }
    const element = document.createElement('dialog');
    element.className = 'rt-dialog';
    element.innerHTML = `<div class="dialog-inner"><div class="dialog-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="rt-dialog-close" aria-label="关闭对话框">×</button></div>${body}</div>`;
    document.body.appendChild(element);
    element.querySelector('.rt-dialog-close').addEventListener('click', () => element.close());
    element.addEventListener('close', () => { if (state.dialog === element) state.dialog = null; element.remove(); }, { once: true });
    element.addEventListener('click', event => { if (event.target === element) { const rect = element.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) element.close(); } });
    state.dialog = element;
    element.showModal();
    return element;
  }

  function downloadArtifact(id) {
    const split = id.lastIndexOf(':');
    const job = list(state.status && state.status.jobs).find(item => item.id === id.slice(0, split));
    const artifact = job && list(job.artifacts)[Number(id.slice(split + 1))];
    if (!artifact) { toast('未找到该作品，请刷新记录'); return; }
    const blob = new Blob([json(artifact.content === undefined ? artifact : artifact.content)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = String(artifact.path || 'artifact.txt').split(/[\\/]/).pop() || 'artifact.txt';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function showJob(id) {
    const panel = dialog('任务完整记录', '服务返回的原始数据，可检查真实状态与交付结果。', '<div id="rtJobDetail">正在读取…</div>');
    try { const data = await api(`/api/jobs/${encodeURIComponent(id)}`); panel.querySelector('#rtJobDetail').innerHTML = `<pre class="rt-content-preview">${esc(json(data.job || data))}</pre>`; }
    catch (error) { errorBox(panel.querySelector('#rtJobDetail'), error.message); }
  }

  function detectPreset(provider) {
    const matching = state.providerPresets.find(preset => preset.baseUrl && preset.baseUrl.replace(/\/+$/, '') === String(provider.baseUrl || '').replace(/\/+$/, ''));
    if (matching) return matching.id;
    if (provider.type === 'anthropic') return 'anthropic';
    if ((provider.baseUrl || '').includes('11434')) return 'ollama';
    if ((provider.baseUrl || '').includes('api.deepseek.com')) return 'deepseek';
    if ((provider.baseUrl || '').includes('api.openai.com')) return 'openai';
    try { if (['api.moonshot.cn', 'api.moonshot.ai'].includes(new URL(provider.baseUrl).hostname)) return 'moonshot'; } catch (_) {}
    return 'custom';
  }

  function providerCard(provider) {
    if(provider.type==='chatgpt-plan')return `<fieldset class="rt-provider" data-provider-id="${esc(provider.id)}" data-plan-account="${esc(provider.accountId)}"><div class="rt-provider-top"><strong>ChatGPT 订阅 · ${esc(provider.model)}</strong><button class="rt-remove-provider" type="button">移除</button></div><label>连接名称<input class="form-input" name="name" value="${esc(provider.name)}"></label><input type="hidden" name="type" value="chatgpt-plan"><input type="hidden" name="baseUrl" value="https://api.openai.com/v1"><input type="hidden" name="model" value="${esc(provider.model)}"><input type="hidden" name="apiKey" value=""><p>${provider.connected?'账号已连接':'需要登录'} · <button class="text-link" data-chatgpt-connect type="button">管理订阅账号</button></p></fieldset>`;
    const selected = detectPreset(provider);
    return `<fieldset class="rt-provider" data-provider-id="${esc(provider.id)}"><div class="rt-provider-top"><strong>模型连接</strong><button class="rt-remove-provider" type="button">移除</button></div><div class="rt-settings-grid"><label>服务商<select class="form-input" name="preset">${Object.entries(presets).map(([key, preset]) => `<option value="${key}"${selected === key ? ' selected' : ''}>${esc(preset.name)}</option>`).join('')}</select></label><label>连接名称<input class="form-input" name="name" value="${esc(provider.name || '')}" required placeholder="例如：我的本地模型"></label><label class="rt-full">API 地址<input class="form-input" name="baseUrl" type="url" value="${esc(provider.baseUrl || '')}" required placeholder="https://your-provider.example/v1"></label><label>模型 ID<input class="form-input" name="model" value="${esc(provider.model || '')}" required placeholder="填入服务商提供的模型 ID"></label><label>API Key ${provider.hasKey ? '<span class="rt-key-set">已配置</span>' : ''}<input class="form-input" name="apiKey" type="password" autocomplete="new-password" placeholder="${provider.hasKey ? '留空保留现有 Key' : '本地 Ollama 通常无需填写'}"></label><label>API 协议<select class="form-input" name="type"><option value="openai"${provider.type !== 'anthropic' ? ' selected' : ''}>OpenAI 兼容</option><option value="anthropic"${provider.type === 'anthropic' ? ' selected' : ''}>Anthropic Messages</option></select></label>${/^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(provider.baseUrl||'')?`<label>DeepSeek 推理模式<select class="form-input" name="thinkingMode"><option value="disabled" ${provider.thinkingMode!=='enabled'?'selected':''}>快速回复（默认）</option><option value="enabled" ${provider.thinkingMode==='enabled'?'selected':''}>深度思考（较慢）</option></select><small>适用于 deepseek-flash / v4-pro</small></label>`:''}<div class="rt-provider-test"><button type="button" class="outline-button rt-test-provider">测试已保存连接</button><small>会发送一条简短模型请求</small></div></div></fieldset>`;
  }

  function currentProviders(panel) {
    return [...panel.querySelectorAll('[data-provider-id]')].map(card => {
      const read = name => card.querySelector(`[name="${name}"]`).value.trim();
      const provider = { id: card.dataset.providerId, name: read('name'), type: read('type'), baseUrl: read('baseUrl'), model: read('model') };
      if(card.querySelector('[name="thinkingMode"]'))provider.thinkingMode=read('thinkingMode');
      if(card.dataset.planAccount)provider.accountId=card.dataset.planAccount;
      const key = read('apiKey');
      if (key) provider.apiKey = key;
      else {
        const saved = list(state.status && state.status.config && state.status.config.providers).find(item => item.id === provider.id);
        if (saved && (saved.baseUrl.replace(/\/+$/, '') !== provider.baseUrl.replace(/\/+$/, '') || saved.type !== provider.type)) provider.apiKey = '';
      }
      return provider;
    });
  }

  function updateAgentOptions(panel, initialMappings) {
    const providers = currentProviders(panel);
    panel.querySelectorAll('[data-agent-mapping]').forEach(select => {
      const value = initialMappings ? initialMappings[select.dataset.agentMapping] || '' : select.value;
      select.innerHTML = `<option value="">使用第一个模型连接</option>${providers.map(provider => `<option value="${esc(provider.id)}">${esc(provider.name || provider.id)}${provider.model ? ` · ${esc(provider.model)}` : ''}</option>`).join('')}`;
      if (providers.some(provider => provider.id === value)) select.value = value;
    });
  }

  async function openSettings(options = {}) {
    shell();
    if (options && typeof options.brief === 'string') { saveDraft({ ...draftFromForm(), ...options }); restoreDraft(state.pendingDraft); }
    else saveDraft(draftFromForm());
    if (!state.status || !state.connected) await refresh();
    if (!state.connected) {
      dialog('连接模型', '先打开本地工作区，你的任务目标会保留在这里。', '<div class="rt-settings-note"><p>在项目目录执行 <code>npm start</code>，然后打开终端显示的本地地址。</p><p>启动本地服务后，可同时添加多个模型连接。</p></div>');
      return;
    }
    const returnToChat=document.body.dataset.view==='chat';
    const panel = dialog('连接模型', '统一管理已连接模型，选择适合你的接入方式。', '<div id="rtQuickSettings"><p class="rt-hint">正在读取可用连接…</p></div>');
    let response;
    try { response = await api('/api/providers'); }
    catch (error) { if (panel.isConnected) errorBox(panel.querySelector('#rtQuickSettings'), `${error.message} 请确认本地服务已更新并重新启动。`); return; }
    if (!panel.isConnected) return;
    state.providerPresets = list(response.presets);
    if (!state.providerPresets.length) { errorBox(panel.querySelector('#rtQuickSettings'), '服务未返回任何模型连接选项。请更新并重新启动本地服务。'); return; }
    state.providerPresets.forEach(preset => { presets[preset.id] = { name: preset.name, type: preset.type || 'openai', baseUrl: preset.baseUrl || '' }; });
    panel.classList.add('rt-batch-dialog');
    panel.querySelector('#rtQuickSettings').innerHTML = `<div class="connection-tabs" role="tablist" aria-label="连接方式"><button type="button" role="tab" data-connection-tab="api" aria-selected="true">🔑 API 密钥 / 本地</button><button type="button" role="tab" data-connection-tab="subscription" aria-selected="false">🎟️ 订阅 / 编码工具</button></div><section id="subscriptionConnections" hidden><p class="rt-hint">不同订阅有各自的授权方式；可用状态以实际接入能力为准。</p><div class="subscription-grid"><article><span class="subscription-icon">◎</span><div><h3>ChatGPT</h3><p>使用支持的官方账号授权连接。无需 API Key。</p></div><button type="button" class="outline-button" data-chatgpt-connect>登录与管理</button></article><article><span class="subscription-icon peach">✳</span><div><h3>Claude</h3><p>当前未接入订阅执行适配器。可在 API 分类连接 Anthropic，或添加你有权限使用的 MCP 工具。</p></div><span class="capability-pending">订阅适配待接入</span></article><article><span class="subscription-icon slate">↗</span><div><h3>Cursor</h3><p>当前未接入 Cursor 执行适配器。订阅不能直接填作 API Key，也不会显示成已连接。</p></div><span class="capability-pending">工具适配待接入</span></article></div><button type="button" class="text-link" data-open-extensions>添加 MCP 工具 →</button></section><form id="rtConnectForm"><section id="rtExistingConnections" class="rt-existing-connections"></section><details class="rt-simple-more"><summary>团队分工 · 可稍后设置</summary><div class="rt-team-entry"><div><strong>为团队安排模型</strong><p>可为需求分析、开发、测试等角色分别安排模型。</p></div><button id="rtManageProviders" type="button" class="outline-button">管理连接与角色分工</button></div></details><div class="rt-batch-heading"><h3>添加模型</h3><span id="rtConnectionCount" class="rt-hint"></span></div><div id="rtConnectRows"></div><button id="rtAddConnection" type="button" class="outline-button rt-add-connection">＋ 再添加一个模型</button><div id="rtQuickError" aria-live="polite"></div><p class="rt-batch-note">${esc(credentialNote())} 每个连接会发送一条简短测试请求，按服务商实际计费。</p><div class="rt-batch-footer"><span id="rtBatchSummary" role="status" aria-live="polite">填写后一起连接，成功的连接会保留。</span><div><button id="rtQuickSubmit" type="submit" class="primary-button">连接所选模型</button><button id="rtFinishConnect" type="button" class="outline-button">完成，返回任务</button></div></div></form>`;
    const form = panel.querySelector('#rtConnectForm');
    const selectCategory=category=>{const subscription=category==='subscription';form.hidden=subscription;panel.querySelector('#subscriptionConnections').hidden=!subscription;panel.querySelectorAll('[data-connection-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.connectionTab===category)));};
    panel.querySelectorAll('[data-connection-tab]').forEach(button=>button.onclick=()=>selectCategory(button.dataset.connectionTab));
    panel.querySelector('[data-open-extensions]').onclick=()=>{panel.close();window.Gongming?.openView('extensions');};
    selectCategory(options.category==='subscription'?'subscription':'api');
    const rows = panel.querySelector('#rtConnectRows');
    let busy = false;
    const savedProviders = () => list(state.status && state.status.config && state.status.config.providers);
    const cards = () => [...rows.querySelectorAll('[data-connect-id]')];
    const totalCount = () => new Set([...savedProviders().map(provider => provider.id), ...cards().map(card => card.dataset.connectId)]).size;
    const selection = card => state.providerPresets.find(preset => preset.id === card.querySelector('[name="presetId"]').value) || state.providerPresets[0];
    const isLocal = preset => !!preset.local || ['ollama', 'lmstudio'].includes(preset.id);
    const setStatus = (card, status, message = '') => {
      card.dataset.connectStatus = status;
      const names = { pending: '待连接', detecting: '正在检测', connecting: '正在连接', connected: '已连接', failed: '连接失败' };
      card.querySelector('.rt-connect-status').textContent = names[status] || names.pending;
      const note = card.querySelector('.rt-connect-result');
      note.textContent = message;
      note.hidden = !message;
    };
    const drawExisting = () => {
      const visible = savedProviders().filter(provider => !cards().some(card => card.dataset.connectId === provider.id));
      panel.querySelector('#rtExistingConnections').innerHTML = visible.length ? `<h3>已有连接 <span>${visible.length}</span></h3><div class="rt-existing-list">${visible.map(provider => `<div class="rt-existing-item"><div><strong>${esc(provider.name || provider.id)}</strong><span>${esc(provider.model)} · ${provider.connected || provider.hasKey || /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(provider.baseUrl) ? '已配置' : provider.type==='chatgpt-plan'?'需登录':'需补填 Key'}</span></div><div class="rt-existing-actions">${provider.type!=='chatgpt-plan'?`<button type="button" class="outline-button" data-update-model="${esc(provider.id)}">查看 / 更新版本</button><button type="button" class="outline-button" data-copy-provider="${esc(provider.id)}">添加另一版本</button>`:''}<button type="button" class="outline-button" data-reconnect="${esc(provider.id)}">${provider.hasKey ? '重新连接' : '连接'}</button></div></div>`).join('')}</div>` : '';
      panel.querySelector('#rtExistingConnections').hidden = !visible.length;
    };
    const syncControls = () => {
      panel.querySelector('.rt-batch-note').textContent = `${credentialNote()} 每个连接会发送一条简短测试请求，按服务商实际计费。`;
      const detecting = cards().some(card => card.dataset.connectStatus === 'detecting');
      const pending = cards().filter(card => card.dataset.connectStatus !== 'connected');
      const failed = pending.filter(card => card.dataset.connectStatus === 'failed');
      panel.querySelector('#rtConnectionCount').textContent = `${totalCount()} / 12 个连接`;
      panel.querySelector('#rtAddConnection').disabled = busy || detecting || totalCount() >= 12;
      panel.querySelector('#rtQuickSubmit').disabled = busy || detecting || !pending.length;
      panel.querySelector('#rtQuickSubmit').textContent = busy ? '正在逐个连接…' : failed.length && failed.length === pending.length ? '重试失败的连接' : '连接所选模型';
      panel.querySelector('#rtFinishConnect').disabled = busy || detecting;
      panel.querySelector('#rtManageProviders').disabled = busy || detecting;
      panel.querySelector('.rt-dialog-close').disabled = busy || detecting;
      panel.querySelectorAll('[data-reconnect]').forEach(button => { button.disabled = busy || detecting; });
      panel.querySelectorAll('[data-copy-provider]').forEach(button => { button.disabled = busy || detecting || totalCount() >= 12; });
      panel.querySelectorAll('[data-update-model]').forEach(button => { button.disabled = busy || detecting; });
      panel.querySelectorAll('[data-chatgpt-connect]').forEach(button => { button.disabled = busy || detecting; });
      cards().forEach(card => {
        const ownDetecting = card.dataset.connectStatus === 'detecting';
        card.querySelector('fieldset').disabled = busy || ownDetecting || card.dataset.connectStatus === 'connected';
        card.querySelector('.rt-remove-connection').disabled = busy || ownDetecting;
        card.querySelector('.rt-copy-connection').disabled = busy || detecting || totalCount() >= 12;
      });
    };
    const applyPreset = card => {
      const preset = selection(card), local = isLocal(preset);
      const key = card.querySelector('[name="apiKey"]'), model = card.querySelector('[name="model"]'), baseUrl = card.querySelector('[name="baseUrl"]');
      card.querySelector('.rt-connect-key').hidden = local;
      key.required = !local && preset.id !== 'custom';
      key.value = ''; key.placeholder = '粘贴此服务的 API Key';model.value = ''; baseUrl.value = '';delete card.dataset.sourceConnection;delete card.dataset.credentialBaseUrl;card.querySelector('datalist').innerHTML='';card.querySelector('.rt-model-versions').replaceChildren();card.querySelector('.rt-model-versions').hidden=true;
      model.placeholder = '读取账号版本后选择，或直接填写模型 ID';
      card.querySelectorAll('[data-provider-shortcut]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.providerShortcut === preset.id)));
      card.querySelector('.rt-model-catalog-note').textContent = local ? '模型来自本机服务；可检测已安装版本。' : '从此账号实时读取版本，不受软件内置列表限制。网页产品名称可能与 API 模型 ID 不同。';
      baseUrl.placeholder = preset.baseUrl || '填写 OpenAI 兼容 API 地址';
      baseUrl.required = preset.id === 'custom'; model.required = preset.id === 'custom';
      card.querySelector('.rt-local-connect').hidden = !local;
      card.querySelector('.rt-local-result').innerHTML = '';
      card.querySelector('.rt-preset-hint').textContent = preset.hint || (local ? '启动本机模型服务后，可检测已安装模型。' : '粘贴 Key 即可连接，也可以先选择模型版本。');
      card.querySelector('.rt-connect-advanced').open = preset.id === 'custom';
      setStatus(card, 'pending');
    };
    const normalizedEndpoint = value => { try {return new URL(value).href.replace(/\/$/,'');} catch {return value.replace(/\/$/,'');} };
    const copyConnection = (provider, sourceCard = null) => {
      const copy=addCard();if(!copy)return;
      copy.querySelector('[name="presetId"]').value=provider?detectPreset(provider):selection(sourceCard).id;applyPreset(copy);
      const sourcePreset=selection(copy),baseUrl=provider?.baseUrl||sourceCard.querySelector('[name="baseUrl"]').value||sourcePreset.baseUrl;
      copy.querySelector('[name="baseUrl"]').value=baseUrl;
      const key=copy.querySelector('[name="apiKey"]');key.value=sourceCard?.querySelector('[name="apiKey"]').value||'';
      const sourceId=provider?.id||sourceCard?.dataset.sourceConnection;
      const source=savedProviders().find(item=>item.id===sourceId);
      if(source?.hasKey){copy.dataset.sourceConnection=source.id;key.required=false;key.placeholder='复用此连接已保存的密钥';}
      copy.dataset.credentialBaseUrl=normalizedEndpoint(baseUrl);
      if(sourceCard)copy.querySelector('datalist').innerHTML=sourceCard.querySelector('datalist').innerHTML;
      copy.querySelector('[name="model"]').focus();syncControls();return copy;
    };
    const addCard = (provider = null) => {
      if (!provider && totalCount() >= 12) { errorBox(panel.querySelector('#rtQuickError'), '最多可配置 12 个模型连接。请先在管理连接中移除不需要的连接。'); return; }
      const id = provider ? provider.id : `connection-${Date.now()}-${++state.providerCounter}`;
      const current = cards().find(card => card.dataset.connectId === id);
      if (current) { current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return current; }
      const preferred = provider ? detectPreset(provider) : 'openai';
      const card = document.createElement('article');
      card.className = 'rt-connect-card'; card.dataset.connectId = id; card.dataset.connectStatus = 'pending';
      card.innerHTML = `<div class="rt-connect-card-top"><strong>${provider ? '重新连接模型' : '新模型连接'}</strong><span class="rt-connect-status">待连接</span><button class="rt-remove-connection" type="button" aria-label="移除此待连接模型">移除</button></div><fieldset><div class="rt-provider-shortcuts" role="group" aria-label="常用服务商">${[['deepseek','DeepSeek'],['moonshot','Kimi'],['openai','OpenAI'],['anthropic','Claude'],['gemini','Gemini'],['ollama','本地 Ollama']].filter(([id]) => state.providerPresets.some(preset => preset.id === id)).map(([id, label]) => `<button type="button" data-provider-shortcut="${id}" aria-pressed="false">${label}</button>`).join('')}</div><div class="rt-connect-fields"><label>服务商<select name="presetId" class="form-input">${state.providerPresets.map(preset => `<option value="${esc(preset.id)}"${preset.id === preferred ? ' selected' : ''}>${esc(preset.name)}</option>`).join('')}</select></label><label class="rt-connect-key">API Key<input name="apiKey" type="password" class="form-input" autocomplete="new-password" placeholder="粘贴此服务的 API Key"></label></div><p class="rt-hint rt-preset-hint"></p><div class="rt-local-connect" hidden><div class="rt-section-top"><strong>本机模型</strong><button type="button" class="outline-button rt-detect-local">检测本地模型</button></div><div class="rt-local-result"></div></div><div class="rt-version-picker"><label>模型版本 / API 模型 ID<input name="model" class="form-input" list="models-${esc(id)}" placeholder="读取列表后选择，也可手动填写模型 ID"><datalist id="models-${esc(id)}"></datalist></label><button type="button" class="outline-button rt-load-models">刷新账号可用版本</button><select class="form-input rt-model-versions" aria-label="选择模型版本" hidden></select><p class="rt-model-catalog-note" role="status" aria-live="polite"></p></div><details class="rt-advanced rt-connect-advanced"><summary>自定义 API 地址</summary><label>API 地址（留空使用预设）<input name="baseUrl" type="url" class="form-input"></label></details></fieldset><button type="button" class="text-link rt-copy-connection">＋ 同一密钥再加一个版本</button><p class="rt-connect-result" role="status" aria-live="polite" hidden></p>`;
      rows.appendChild(card); applyPreset(card);
      if (provider) {
        card.querySelector('[name="model"]').value = provider.model || '';
        card.querySelector('[name="baseUrl"]').value = provider.baseUrl || '';
        card.querySelector('[name="apiKey"]').required = !isLocal(selection(card)) && !provider.hasKey;
        card.querySelector('[name="apiKey"]').placeholder = provider.hasKey ? '留空保留此连接已保存的 Key' : '重新填写此服务的 API Key';
      }
      card.querySelectorAll('[data-provider-shortcut]').forEach(button => button.onclick = () => {
        const select = card.querySelector('[name="presetId"]');
        if (select.value === button.dataset.providerShortcut) return;
        select.value = button.dataset.providerShortcut; applyPreset(card); syncControls();
        card.querySelector(isLocal(selection(card)) ? '.rt-detect-local' : '[name="apiKey"]').focus();
      });
      card.querySelector('.rt-load-models').onclick=async()=>{
        if(busy || cards().some(item=>item.dataset.connectStatus==='detecting'))return;
        card.querySelector('datalist').replaceChildren();card.querySelector('.rt-model-versions').hidden=true;
        const button=card.querySelector('.rt-load-models');setStatus(card,'detecting');syncControls();button.textContent='正在读取…';
        try{
          const key=card.querySelector('[name="apiKey"]').value.trim();
          const payload={presetId:selection(card).id,connectionId:card.dataset.connectId,...(card.dataset.sourceConnection?{sourceConnectionId:card.dataset.sourceConnection}:{}),baseUrl:card.querySelector('[name="baseUrl"]').value.trim(),...(key?{apiKey:key}:{})};
          const result=await api('/api/providers/models',payload);delete payload.apiKey;if(!card.isConnected)return;const models=list(result.models).filter(model=>typeof model.id==='string' && model.id);
          const currentModel=card.querySelector('[name="model"]').value.trim();
          card.querySelector('datalist').innerHTML=models.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
          const versions=card.querySelector('.rt-model-versions');versions.innerHTML='<option value="">选择账号可用版本</option>'+models.map(m=>`<option value="${esc(m.id)}">${esc(m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id)}</option>`).join('');versions.hidden=!models.length;
          if(models.some(model=>model.id===currentModel))versions.value=currentModel;
          const note=card.querySelector('.rt-model-catalog-note');
          note.textContent=models.length ? `刚刚从账号读取 ${models.length} 个版本。${currentModel && !models.some(model=>model.id===currentModel) ? '当前填写的型号未出现在返回列表中，请确认权限或选择可用版本；原连接未改动。' : '选择版本后点击“连接所选模型”才会保存。'}` : '账号没有返回可用版本。可检查 API Key / 服务地址，或手动填写服务商确认可用的模型 ID。';
          versions.onchange=()=>{if(versions.value){card.querySelector('[name="model"]').value=versions.value;note.textContent=`已选择 ${versions.value}，点击“连接所选模型”后生效。`;}};setStatus(card,'pending');
        }catch(error){if(card.isConnected){card.querySelector('.rt-model-catalog-note').textContent=`未能读取版本：${error.message} 你仍可手动填写确认可用的模型 ID；已有连接不受影响。`;setStatus(card,'pending');}}finally{if(card.isConnected){button.textContent='刷新账号可用版本';syncControls();}}
      };
      card.querySelector('.rt-copy-connection').onclick=()=>{
        copyConnection(savedProviders().find(p=>p.id===card.dataset.connectId),card);
      };
      card.querySelector('[name="presetId"]').addEventListener('change', () => { applyPreset(card); syncControls(); });
      card.querySelector('[name="apiKey"]').addEventListener('input', () => {
        card.querySelector('datalist').replaceChildren();card.querySelector('.rt-model-versions').hidden=true;
        card.querySelector('.rt-model-catalog-note').textContent='密钥已填写或修改，可以刷新此账号的可用版本，也可以手动填写模型 ID。';
      });
      card.querySelector('[name="baseUrl"]').addEventListener('input', () => {
        card.querySelector('datalist').replaceChildren();card.querySelector('.rt-model-versions').hidden=true;
        card.querySelector('.rt-model-catalog-note').textContent='服务地址已变更，请重新读取此账号的可用版本，或手动填写模型 ID。';
        const original=card.dataset.credentialBaseUrl || provider?.baseUrl;
        const endpoint=card.querySelector('[name="baseUrl"]').value.trim()||selection(card).baseUrl;
        if (original && normalizedEndpoint(endpoint) !== normalizedEndpoint(original)) {
          card.querySelector('[name="apiKey"]').value = '';
          card.querySelector('[name="apiKey"]').required = !isLocal(selection(card));
          card.querySelector('[name="apiKey"]').placeholder = '地址已修改，请重新填写此服务的 API Key';
          delete card.dataset.sourceConnection;delete card.dataset.credentialBaseUrl;
        }
      });
      card.querySelector('.rt-remove-connection').addEventListener('click', () => { card.querySelector('[name="apiKey"]').value = ''; card.remove(); drawExisting(); syncControls(); });
      card.querySelector('.rt-detect-local').addEventListener('click', async event => {
        const trigger = event.currentTarget, presetId = selection(card).id;
        setStatus(card, 'detecting'); syncControls(); trigger.textContent = '正在检测…';
        try {
          const data = await api('/api/providers/local');
          if (!panel.isConnected || !card.isConnected) return;
          const provider = list(data.providers).find(item => item.presetId === presetId), models = list(provider && provider.models);
          const result = card.querySelector('.rt-local-result');
          if (!provider || !provider.available) result.innerHTML = '<p class="rt-hint">尚未检测到服务。请先启动所选本地服务，再重新检测。</p>';
          else if (!models.length) result.innerHTML = '<p class="rt-hint">服务已启动，但还没有可用模型。请先安装或加载模型。</p>';
          else {
            result.innerHTML = `<label>选择已安装模型<select class="form-input rt-detected-model">${models.map(model => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('')}</select></label><p class="rt-hint">检测到 ${models.length} 个模型。</p>`;
            const detected = result.querySelector('select');
            card.querySelector('[name="model"]').value = detected.value;
            detected.addEventListener('change', () => { card.querySelector('[name="model"]').value = detected.value; });
          }
          setStatus(card, 'pending');
        } catch (error) { if (card.isConnected) setStatus(card, 'failed', error.message); }
        finally { if (trigger.isConnected) { trigger.textContent = '检测本地模型'; syncControls(); } }
      });
      drawExisting(); syncControls(); return card;
    };
    const preventBusyClose = event => { if (busy || cards().some(card => card.dataset.connectStatus === 'detecting')) event.preventDefault(); };
    panel.addEventListener('cancel', preventBusyClose);
    panel.addEventListener('click', event => { if ((busy || cards().some(card => card.dataset.connectStatus === 'detecting')) && event.target === panel) event.stopImmediatePropagation(); }, true);
    panel.querySelector('#rtAddConnection').addEventListener('click', () => { const card = addCard(); card?.querySelector('select').focus(); });
    panel.querySelector('#rtExistingConnections').addEventListener('click', event => { const update=event.target.closest('[data-update-model]');if(update){const provider=savedProviders().find(item=>item.id===update.dataset.updateModel);if(provider){cards().filter(card=>!savedProviders().some(saved=>saved.id===card.dataset.connectId) && !card.dataset.sourceConnection && card.dataset.connectStatus==='pending' && ['apiKey','model','baseUrl'].every(name=>!card.querySelector(`[name="${name}"]`).value.trim())).forEach(card=>card.remove());const card=addCard(provider);if(card){card.querySelector('.rt-connect-card-top>strong').textContent='查看 / 更新模型版本';card.querySelector('.rt-load-models').click();card.scrollIntoView({block:'nearest',behavior:'smooth'});}}return;}const copy=event.target.closest('[data-copy-provider]');if(copy){copyConnection(savedProviders().find(item=>item.id===copy.dataset.copyProvider));return;}const target = event.target.closest('[data-reconnect]'); if (target) { const provider = savedProviders().find(item => item.id === target.dataset.reconnect); if (provider?.type==='chatgpt-plan'){window.ChatGPTUI?.open();return;}if (provider) addCard(provider); } });
    panel.querySelector('#rtManageProviders').addEventListener('click', () => window.ConnectionsUI?.team());
    panel.querySelector('#rtFinishConnect').addEventListener('click', async () => {
      panel.close(); await refresh();await window.ConnectionsUI?.refresh();await window.ChatUI?.refreshModels?.();if(returnToChat)document.getElementById('chatText')?.focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || cards().some(card => card.dataset.connectStatus === 'detecting')) return;
      const pending = cards().filter(card => card.dataset.connectStatus !== 'connected');
      if (!pending.length || !form.reportValidity()) return;
      if (totalCount() > 12) { errorBox(panel.querySelector('#rtQuickError'), '最多可配置 12 个模型连接，请移除多余的待连接项。'); return; }
      busy = true; syncControls(); panel.querySelector('#rtQuickError').innerHTML = '';
      let completed = 0, failed = 0;
      for (const card of pending) {
        const preset = selection(card), payload = { presetId: preset.id, connectionId: card.dataset.connectId, ...(card.dataset.sourceConnection?{sourceConnectionId:card.dataset.sourceConnection}:{}) };
        ['apiKey', 'model', 'baseUrl'].forEach(name => { const value = card.querySelector(`[name="${name}"]`).value.trim(); if (value) payload[name] = value; });
        setStatus(card, 'connecting');
        panel.querySelector('#rtBatchSummary').textContent = `正在连接 ${completed + failed + 1} / ${pending.length}，请稍候…`;
        try {
          const data = await api('/api/providers/connect', payload, 300000);
          if (data.config) state.status.config = data.config;
          const provider = data.provider || savedProviders().find(item => item.id === payload.connectionId);
          if (!data.config && provider) state.status.config.providers = [...savedProviders().filter(item => item.id !== provider.id), provider];
          card.querySelector('[name="apiKey"]').value = '';
          card.querySelector('fieldset').hidden = true;
          card.querySelector('.rt-connect-card-top>strong').textContent = provider?.name || preset.name;
          card.querySelector('.rt-remove-connection').textContent = '收起';
          card.querySelector('.rt-remove-connection').setAttribute('aria-label', '收起已连接模型');
          setStatus(card, 'connected', `${provider?.model || payload.model || '默认模型'} · 已可使用`);
          completed++;
        } catch (error) { setStatus(card, 'failed', `${error.message} 修改后可重试，其他成功的连接已保留。`); failed++; }
        finally { delete payload.apiKey; }
      }
      busy = false;
      await refresh(); drawExisting(); syncControls();
      panel.querySelector('#rtBatchSummary').textContent = `本次 ${completed} 个已连接${failed ? `，${failed} 个失败，可修改后重试` : '。可继续添加或返回任务'}。`;
    });
    drawExisting(); if (totalCount() < 12) addCard(); else syncControls();
  }

  async function openAdvancedSettings() {
    if (!state.status || !state.connected) await refresh();
    if (!state.connected) {
      dialog('连接你的本地工作区', '当前页面是静态演示，模型配置需要本地服务。', '<div class="rt-settings-note"><strong>启动真实服务</strong><p>下载完整项目并解压，在项目目录打开终端，执行：</p><pre>npm start</pre><p>然后打开终端显示的本地地址，进入「连接模型」。模型 Key 只发给你本机的服务，不保存在浏览器。</p></div>');
      return;
    }
    const config = state.status.config || {};
    const providers = list(config.providers);
    const agents = list(state.status.agents);
    const panel = dialog('连接模型与项目', '一个团队可以使用多个模型连接，为不同角色安排合适的模型。', `<form id="rtSettingsForm"><label class="field-label" for="rtProjectPath">项目绝对路径</label><input id="rtProjectPath" name="projectPath" class="form-input" required value="${esc(config.projectPath || '')}" placeholder="例如 C:\\Projects\\my-app 或 /home/me/projects/my-app"><p class="rt-hint">填写本机已有 Git 项目目录；任务将在该项目内创建隔离工作区。</p><div class="rt-section-top rt-settings-section"><h3>模型连接</h3><button type="button" class="outline-button" id="rtAddProvider">添加连接</button></div><div id="rtProviders">${providers.map(providerCard).join('')}</div><div id="rtNoProviders" class="rt-hint"${providers.length ? ' hidden' : ''}>还没有模型连接。点击「添加连接」开始配置。</div><div class="rt-section-top rt-settings-section"><h3>角色与模型分工</h3></div><div class="rt-settings-grid">${agents.map(agent => `<label>${esc(agent.name || agent.id)}<select class="form-input" data-agent-mapping="${esc(agent.id)}" aria-label="${esc(agent.name || agent.id)}使用的模型"></select></label>`).join('')}</div><div class="rt-settings-note">${esc(credentialNote())} 模型 ID 请使用服务商或 Ollama 实际可用的名称。不同厂商之间不共享缓存，分工不会自动降低 token 计费。</div><div id="rtSettingsError" aria-live="polite"></div><div class="dialog-footer"><small>保存设置不会发起模型调用。<br>「测试连接」和「创建真实协作」会调用模型。</small><button type="submit" class="primary-button">保存配置</button></div></form>`);
    panel.querySelector('#rtProjectPath').required = false;
    panel.querySelector('label[for="rtProjectPath"]').textContent = '已有代码项目路径（可选）';
    panel.querySelector('#rtProjectPath').nextElementSibling.textContent = '仅修改已有代码仓库时使用。文档、PPT、新网站和一般任务可留空。';
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'outline-button'; back.textContent = '返回快捷连接';
    back.addEventListener('click', () => openSettings());
    panel.querySelector('.dialog-footer').prepend(back);
    updateAgentOptions(panel, config.agentProviders || {});
    panel.querySelector('#rtAddProvider').disabled = providers.length >= 12;
    panel.querySelector('#rtAddProvider').addEventListener('click', () => {
      if (currentProviders(panel).length >= 12) { errorBox(panel.querySelector('#rtSettingsError'), '最多可配置 12 个模型连接。'); return; }
      const provider = { ...presets.ollama, id: `provider-${Date.now()}-${++state.providerCounter}`, model: '' };
      panel.querySelector('#rtProviders').insertAdjacentHTML('beforeend', providerCard(provider));
      panel.querySelector('#rtNoProviders').hidden = true;
      updateAgentOptions(panel);
      panel.querySelector('#rtAddProvider').disabled = currentProviders(panel).length >= 12;
    });
    panel.addEventListener('change', event => {
      const card = event.target.closest('[data-provider-id]');
      if (card && event.target.name === 'preset') {
        const preset = presets[event.target.value];
        card.querySelector('[name="name"]').value = preset.name;
        card.querySelector('[name="baseUrl"]').value = preset.baseUrl;
        card.querySelector('[name="type"]').value = preset.type;
        card.querySelector('[name="model"]').value = '';
        card.querySelector('[name="apiKey"]').value = '';
      }
      if (card) updateAgentOptions(panel);
    });
    panel.addEventListener('click', async event => {
      const remove = event.target.closest('.rt-remove-provider');
      if (remove) { remove.closest('[data-provider-id]').remove(); updateAgentOptions(panel); panel.querySelector('#rtNoProviders').hidden = currentProviders(panel).length > 0; panel.querySelector('#rtAddProvider').disabled = currentProviders(panel).length >= 12; return; }
      const test = event.target.closest('.rt-test-provider');
      if (test) {
        const card = test.closest('[data-provider-id]');
        const id = card.dataset.providerId;
        const saved = list(state.status.config.providers).find(provider => provider.id === id);
        if (!saved) { errorBox(panel.querySelector('#rtSettingsError'), '请先保存配置，再测试此连接。'); return; }
        const current = currentProviders(panel).find(provider => provider.id === id);
        if (['type', 'baseUrl', 'model'].some(key => current[key] !== saved[key]) || Object.prototype.hasOwnProperty.call(current, 'apiKey')) { errorBox(panel.querySelector('#rtSettingsError'), '此连接有未保存的修改。请先保存后重新打开设置，再测试连接。'); return; }
        test.disabled = true; panel.querySelector('#rtSettingsError').innerHTML = '';
        try { const data = await api('/api/config/test', { provider: id }, 300000); panel.querySelector('#rtSettingsError').innerHTML = `<div class="rt-success" role="status">连接测试返回：<pre>${esc(json(data))}</pre></div>`; }
        catch (error) { errorBox(panel.querySelector('#rtSettingsError'), error.message); }
        finally { test.disabled = false; }
      }
    });
    panel.querySelector('#rtSettingsForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      const error = panel.querySelector('#rtSettingsError');
      const configured = currentProviders(panel);
      if (!configured.length) { errorBox(error, '请至少添加一个模型连接。'); return; }
      const agentProviders = {};
      panel.querySelectorAll('[data-agent-mapping]').forEach(select => { if (select.value) agentProviders[select.dataset.agentMapping] = select.value; });
      submit.disabled = true; error.innerHTML = '';
      try {
        await api('/api/config', { projectPath: panel.querySelector('#rtProjectPath').value.trim(), providers: configured, agentProviders });
        panel.close(); toast('模型与项目配置已保存'); await refresh();
      } catch (failure) { errorBox(error, failure.message); }
      finally { if (submit.isConnected) submit.disabled = false; }
    });
  }

  window.RuntimeUI = Object.freeze({ render, openSettings, openAdvancedSettings, refresh, startTask });
})();
