(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const list = value => Array.isArray(value) ? value : [];
  const icons = {ppt:'slides',website:'globe',document:'doc',project:'branch',code:'code'};
  const kinds = {ppt:'演示文稿',website:'网站',document:'文档',project:'项目',code:'代码',auto:'协作任务',work:'日常工作'};
  const labels = {pending:'等待开始',queued:'已排队',running:'正在进行',completed:'已完成',failed:'需要处理',interrupted:'已中断',paused:'已暂停',awaiting_approval:'等待确认',blocked:'等待前置任务'};
  const stages = {orchestrator:'梳理需求',context:'整理资料',architect:'制定方案',developer:'制作内容',tester:'检查成果',docs:'补充说明',regression:'逐项验收',git:'整理交付'};
  let snapshot = null, loading = null, timer = null;
  const generations = new Map();
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const dateValue = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const when = value => dateValue(value) ? new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '时间未记录';
  const jobs = () => list(snapshot?.jobs).filter(job => job && typeof job.id === 'string').slice().sort((a,b) => dateValue(b.updatedAt || b.createdAt) - dateValue(a.updatedAt || a.createdAt));
  const hasResult = job => Boolean(job.deliverable?.artifact);

  async function read() {
    if (!loading) loading = (async () => {
      const response = await fetch('/api/status', {headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('暂时无法读取本机任务');
      const data = await response.json();
      if (data.mode !== 'local' || !Array.isArray(data.jobs)) throw new Error('请通过Resonance桌面应用或本地服务打开');
      snapshot = {jobs:data.jobs,approvals:list(data.approvals)};
      return snapshot;
    })().finally(() => { loading = null; });
    return loading;
  }

  function card(job) {
    const tasks = list(job.tasks), done = tasks.filter(task => task.status === 'completed').length;
    const progress = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const kind = Object.prototype.hasOwnProperty.call(icons,job.kind) ? job.kind : 'document';
    const pending = list(snapshot?.approvals).some(item => item.jobId === job.id && item.status === 'pending');
    const status = job.recoveryIncomplete ? '历史记录' : pending ? '等待确认' : labels[job.status] || '状态待确认';
    const statusClass = pending ? 'awaiting_approval' : Object.prototype.hasOwnProperty.call(labels,job.status) ? job.status : 'pending';
    const running = tasks.filter(task => task.status === 'running').map(task => stages[task.id] || task.title || '执行任务');
    const detail = job.recoveryIncomplete ? '可查看已保留的成果与工作记录。' : pending ? '有操作等待你的确认，已完成的内容会保留。' : job.status === 'running' ? (running.length ? `正在${running.join('、')}。` : '团队正在安排下一步工作。') : hasResult(job) ? (job.status === 'completed' ? '成果已就绪，可以预览、批注与审阅。' : '已有阶段成果，可以先打开查看。') : ['failed','interrupted'].includes(job.status) ? '查看工作记录，了解原因与已完成的进展。' : job.status === 'completed' ? '交付文件和完整过程保存在工作记录中。' : '任务进展与成果会保存在这里。';
    return `<article class="hub-card"><div class="hub-card-top"><span class="hub-kind hub-kind-${kind}">${icon(icons[kind])}${esc(kinds[job.kind] || '协作任务')}</span><span class="hub-status status-${statusClass}">${esc(status)}</span></div><h3>${esc(job.brief || '未命名任务')}</h3><p>${esc(detail)}</p><div class="hub-progress" role="progressbar" aria-label="已完成步骤" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div><div class="hub-card-meta"><span>${tasks.length ? `${done} / ${tasks.length} 步已完成` : '等待团队安排'}</span><time>${esc(when(job.updatedAt || job.createdAt))}</time></div><div class="hub-card-actions"><button type="button" class="outline-button" data-hub-job="${esc(job.id)}">${hasResult(job) ? '打开成果与审阅' : '查看工作记录'} ${icon('arrow')}</button>${hasResult(job) ? `<button type="button" class="text-link" data-view="runtime">工作记录</button>` : ''}</div></article>`;
  }

  function paint(target, full, failure) {
    const all = jobs(), items = full ? all.slice().sort((a,b) => Number(hasResult(b)) - Number(hasResult(a))) : all.slice(0,3);
    const title = full ? '成果与进展' : '继续手边的工作';
    const subtitle = all.length ? `${all.length} 个真实任务 · ${all.filter(hasResult).length} 个已有可预览成果` : '从一句需求开始，成果会留在这里';
    const heading = `<div class="hub-section-header"><div class="hub-heading"><h${full?'1':'2'}>${title}</h${full?'1':'2'}><p>${esc(subtitle)}</p></div><div class="button-row">${full ? '<button type="button" class="outline-button" data-hub-refresh="results">刷新</button><button type="button" class="primary-button" data-view="chat">开始对话</button>' : '<button type="button" class="text-link" data-view="results">全部成果与进展 →</button>'}</div></div>`;
    const error = failure ? `<div class="hub-error" role="status">${snapshot ? '连接暂时中断，以下为上次读取的记录。' : '暂时无法读取本机任务。'}<button type="button" class="text-link" data-hub-refresh="${full?'results':'home'}">重新读取</button></div>` : '';
    const empty = `<div class="hub-empty">${icon('folder')}<div><strong>给第一个想法留个位置</strong><p>做一份 PPT、整理资料，或开始一个项目。</p></div><button type="button" class="outline-button" data-view="chat">聊聊要做的事 ${icon('arrow')}</button></div>`;
    target.innerHTML = heading + error + (items.length ? `<div class="hub-grid">${items.map(card).join('')}</div>` : failure ? '' : empty);
  }

  function schedule() {
    clearTimeout(timer);
    if (document.hidden || !['discover','results'].includes(document.body.dataset.view) || !jobs().some(job => ['running','queued'].includes(job.status))) return;
    timer = setTimeout(() => { if (document.body.dataset.view === 'results') results(); else if (document.body.dataset.view === 'discover') render(); },5000);
  }

  async function update(id, full) {
    const target = document.getElementById(id);
    if (!target) return;
    const generation = (generations.get(id) || 0) + 1;
    generations.set(id,generation);
    if (!target.children.length) target.innerHTML = '<p class="hub-loading" role="status">正在读取本机任务…</p>';
    try {
      await read();
      if (target.isConnected && generations.get(id) === generation) paint(target,full,false);
    } catch {
      if (target.isConnected && generations.get(id) === generation) paint(target,full,true);
    } finally { schedule(); }
  }

  function render() { return update('liveWorkHome',false); }
  function results() { return update('resultsView',true); }
  document.addEventListener('click', event => {
    const refresh = event.target.closest('[data-hub-refresh]');
    if (refresh) { refresh.dataset.hubRefresh === 'results' ? results() : render(); return; }
    const button = event.target.closest('[data-hub-job]');
    if (!button) return;
    const job = jobs().find(item => item.id === button.dataset.hubJob);
    if (job && hasResult(job) && window.WorkflowsUI?.openResult) window.WorkflowsUI.openResult(job.id);
    else window.Gongming?.openView('runtime');
  });
  const refreshVisible = () => { if (document.hidden) return; if (document.body.dataset.view === 'results') results(); else if (document.body.dataset.view === 'discover') render(); };
  document.addEventListener('visibilitychange',refreshVisible);
  window.addEventListener('focus',refreshVisible);
  window.WorkHub = Object.freeze({render,results});
})();
