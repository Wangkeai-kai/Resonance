(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles = [
    ['orchestrator', '总控', '分析需求、安排分工'], ['context', '项目检索', '梳理代码与依赖'],
    ['architect', '方案设计', '规划结构与接口'], ['frontend', '前端', '制作页面与交互'],
    ['backend', '后端', '实现接口与数据逻辑'], ['developer', '制作与整合', '制作内容、整合文件'],
    ['tester', '测试', '生成测试、反馈问题'], ['docs', '文档', '同步说明文档'],
    ['regression', '验收', '逐项核对需求'], ['git', '版本整理', '整理变更与提交说明']
  ];
  function resolve(config, role) {
    const mapping = config.agentProviders || {}, providers = config.providers || [];
    const id = mapping[role] || (['frontend','backend'].includes(role) ? mapping.developer : undefined) || mapping.orchestrator || providers[0]?.id;
    return providers.find(provider => provider.id === id);
  }
  function readiness(provider) {
    if (provider.type === 'chatgpt-plan') return provider.connected ? '已授权' : '需重新登录';
    try { if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname)) return '本地服务'; } catch {}
    return provider.hasKey ? '密钥已保存' : '需补充密钥';
  }
  function roster(config, selected) {
    const providers = config.providers || [], lead = resolve(config, 'orchestrator');
    if (!providers.length) return '<div class="team-empty">🔌 连接一个模型即可开始，也可以添加多家模型一起协作。<button type="button" data-action="connect">连接模型 →</button></div>';
    return providers.map(provider => {
      const assigned = roles.filter(([role]) => resolve(config, role)?.id === provider.id), isLead = provider.id === lead?.id;
      return `<article class="team-member${isLead?' team-member-lead':''}" data-team-provider="${esc(provider.id)}"><div class="team-member-heading"><span class="team-member-icon" aria-hidden="true">${isLead?'🧭':'✦'}</span><strong>${esc(provider.name)}</strong><small>${isLead?'主模型 · 总控':provider.id===selected?'当前对话':'协作模型'}</small></div><p class="team-member-version">${esc(provider.model)}</p><div class="team-role-tags">${assigned.map(([role,label,description])=>`<span data-member-role="${role}" title="${description}">${label}</span>`).join('')||'<span>暂未分配职责</span>'}</div><p class="team-member-state">${esc(readiness(provider))}${provider.id===selected&&isLead?' · 也用于当前对话':''}${provider.id===selected&&!isLead&&assigned.length?' · 已加入协作':''}</p></article>`;
    }).join('');
  }
  function assignment(job, task) {
    if (task.modelAssignment) return {...task.modelAssignment, source: '执行记录'};
    const provider = job.configSnapshot && resolve(job.configSnapshot, task.coordinated?'orchestrator':task.agentId||task.id);
    return provider ? {providerId:provider.id,name:provider.name,model:provider.model,source:'创建时配置 · 实际调用未记录'} : {name:'未记录模型',model:'',source:'旧任务没有模型记录'};
  }
  const statuses = {completed:'已完成',running:'进行中',queued:'等待开始',blocked:'等待前置步骤',awaiting_approval:'等你确认',failed:'未完成',interrupted:'已中断',skipped:'已跳过'};
  function taskTeam(job) {
    const tasks = job.tasks || [];
    if (!tasks.length) return '';
    const running = tasks.filter(task=>task.status==='running');
    return `${running.length?`<div class="task-live-members">${running.map(task=>{const member=assignment(job,task);return `<p><span class="team-live-dot"></span>${esc(roles.find(([id])=>id===task.id)?.[1]||task.title)} · ${esc(member.name)}${member.model?` <small>${esc(member.model)}</small>`:''}${member.source!=='执行记录'?` <small>（${esc(member.source)}）</small>`:''}</p>`;}).join('')}</div>`:''}<details class="task-team-details"><summary>查看这项任务的模型与分工</summary><p>每一步独立记录模型；上方团队设置用于后续调用。</p><div class="task-member-list">${tasks.map(task=>{const member=assignment(job,task);return `<div><strong>${esc(roles.find(([id])=>id===task.id)?.[1]||task.title)}</strong><span>${esc(member.name)}<small>${esc(member.model)} · ${esc(member.source)}</small></span><em>${esc(statuses[task.status]||task.status)}</em></div>`;}).join('')}</div></details>`;
  }
  function avatar(provider, extra = '') {
    const name=provider?.name||'模型',id=provider?.id||name,hue=[...id].reduce((n,c)=>n+c.codePointAt(0),0)%360;
    return `<span class="member-avatar ${extra}" style="--member-hue:${hue}" aria-hidden="true">${esc([...name][0]?.toUpperCase()||'✦')}</span>`;
  }
  function conversationRoster(chat, config) {
    const providers=config.providers||[],ids=chat.kind==='direct'?[chat.directProviderId]:(chat.participantIds||[]);
    return ids.map(id=>{
      const provider=providers.find(p=>p.id===id),isLead=chat.kind==='team'&&id===chat.leadProviderId;
      if(!provider)return `<article class="team-member team-member-unavailable"><strong>模型已移除</strong><p class="team-member-state">请重新连接模型，或新建群聊选择成员。</p></article>`;
      const assigned=roles.filter(([role])=>resolve(config,role)?.id===id);
      return `<article class="team-member${isLead?' team-member-lead':''}" data-team-provider="${esc(id)}"><div class="team-member-heading">${avatar(provider)}<strong>${esc(provider.name)}</strong><small>${isLead?'主模型 · 总控':chat.kind==='direct'?'单独对话':'群聊成员'}</small></div><p class="team-member-version">${esc(provider.model)}</p><div class="team-role-tags">${assigned.map(([role,label,description])=>`<span title="协作任务：${esc(description)}">${esc(label)}</span>`).join('')||'<span>参与讨论</span>'}</div><p class="team-member-state">${esc(readiness(provider))}</p></article>`;
    }).join('');
  }
  window.TeamUI = {roles, resolve, roster, assignment, taskTeam, avatar, conversationRoster};
})();

