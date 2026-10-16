(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  const list = value => Array.isArray(value) ? value : [];
  const savedKey = 'gongming.requirements-draft';
  let panel, analysis, busy = false, history = [];
  let draft = '';
  try { draft = sessionStorage.getItem(savedKey) || ''; } catch {}
  const remember = value => { draft = value; try { sessionStorage.setItem(savedKey, value); } catch {} };
  const request = async (url, body) => {
    const response = await fetch(url, {method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '请求失败，请稍后重试');
    return data;
  };
  const blocks = (title, items, className = '') => items.length ? `<section class="req-block ${className}"><h3>${title}</h3><ul>${items.map(item => `<li>${escape(text(item))}</li>`).join('')}</ul></section>` : '';
  function showResult() {
    const target = panel?.querySelector('#reqResult');
    if (!target || !analysis) return;
    const result = analysis.result || {};
    const unchanged = panel.querySelector('#reqBrief').value.trim() === analysis.brief;
    target.innerHTML = `<div class="req-plan-title"><span>总协调 Agent · 需求方案</span><small>${escape(new Date(analysis.createdAt).toLocaleString('zh-CN'))}</small></div><p class="req-summary">${escape(text(result.summary))}</p>${blocks('交付成果',list(result.deliverables))}<section class="req-block"><h3>需求与验收标准</h3><div class="req-checklist">${list(result.requirements).map((item,index)=>`<article><span>${String(index+1).padStart(2,'0')}</span><div><strong>${escape(text(item.text || item))}</strong><p>${escape(text(item.acceptance || '需补充具体的验收方式'))}</p></div></article>`).join('') || '<p>未返回可执行需求，请补充目标后重新分析。</p>'}</div></section><div class="req-scope">${blocks('这次要做',list(result.scope?.included))}${blocks('暂不包含',list(result.scope?.excluded))}</div>${blocks('需要你补充的信息',list(result.questions),'req-questions')}${blocks('风险与注意事项',list(result.risks))}<div class="req-actions"><p>${unchanged ? '检查方案后再交给团队。此时尚未创建项目或修改文件。' : '需求已修改，请重新分析后再开始。'}</p><button type="button" class="primary-button" id="reqStart" ${unchanged && list(result.requirements).length ? '' : 'disabled'}>按此方案开始</button></div>`;
    target.querySelector('#reqStart').onclick = async () => {
      if (busy || panel.querySelector('#reqBrief').value.trim() !== analysis.brief) return;
      const approved = analysis;
      panel.close();
      await window.RuntimeUI.startTask({brief: approved.brief, kind: 'auto', analysisId: approved.id});
    };
  }
  async function analyze() {
    if (busy) return;
    const brief = panel.querySelector('#reqBrief').value.trim();
    if (brief.length < 3) { panel.querySelector('#reqBrief').reportValidity(); return; }
    remember(brief);
    busy = true;
    const button = panel.querySelector('#reqAnalyze');
    const error = panel.querySelector('#reqError');
    button.disabled = true; button.textContent = '正在分析需求…'; error.innerHTML = '';
    try {
      const status = await request('/api/status');
      if (!status.capabilities?.model) {
        error.innerHTML = '<p class="rt-hint">先连接一个模型，再返回这里分析。需求已保留。</p><button type="button" class="outline-button" id="reqConnect">连接模型</button>';
        error.querySelector('#reqConnect').onclick = () => { panel.close(); window.RuntimeUI.openSettings(); };
        return;
      }
      const data = await request('/api/requirements/analyze', {brief, kind:'auto'});
      analysis = data.analysis;
      history = [analysis,...history.filter(item=>item.id!==analysis.id)];
      showResult();
      renderHistory();
      panel.querySelector('#reqResult').scrollIntoView({behavior:'smooth',block:'start'});
    } catch (failure) {
      error.innerHTML = `<div class="rt-error" role="alert">${escape(failure.name === 'TimeoutError' ? '分析等待超时。可以稍后重新打开需求管控，查看是否已有结果。' : failure.message)}</div>`;
    } finally {
      busy = false; button.disabled = false; button.textContent = '分析需求';
    }
  }
  function renderHistory() {
    const target = panel.querySelector('#reqHistory');
    target.innerHTML = history.length ? `<label for="reqPrevious">已保存的需求方案</label><select id="reqPrevious" class="form-input"><option value="">选择历史方案</option>${history.map(item=>`<option value="${escape(item.id)}">${escape(item.brief.slice(0,65))}</option>`).join('')}</select>` : '';
    target.querySelector('select')?.addEventListener('change', event=>{
      const selected = history.find(item=>item.id===event.target.value);
      if (!selected) return;
      analysis=selected;panel.querySelector('#reqBrief').value=selected.brief;remember(selected.brief);showResult();
    });
  }
  async function open(options={}) {
    if (panel?.open) { panel.focus(); return; }
    if (options.brief) remember(options.brief);
    if (!panel) {
      panel=document.createElement('dialog');panel.className='req-dialog';panel.setAttribute('aria-label','需求管控');document.body.append(panel);
      panel.innerHTML=`<div class="dialog-inner"><div class="dialog-header"><div><span class="rt-eyebrow">总协调 Agent</span><h2>先把需求想清楚</h2><p>梳理目标、范围和验收标准，再安排团队执行。</p></div><button type="button" class="icon-btn" id="reqClose" aria-label="关闭需求管控">×</button></div><form id="reqForm"><label class="field-label" for="reqBrief">想做什么？</label><textarea id="reqBrief" class="form-textarea" minlength="3" maxlength="20000" required placeholder="告诉我目标、使用者、想要的成果，以及时间或预算限制。"></textarea><div class="task-model-entry"><span>使用团队总控模型分析</span><button type="button" class="text-link" data-manage-models>＋ 添加 / 管理模型</button></div><div class="req-toolbar"><span>仅进行需求分析，不会改动项目文件。</span><button type="submit" class="primary-button" id="reqAnalyze">分析需求</button></div></form><div id="reqError" aria-live="polite"></div><div id="reqResult" aria-live="polite"></div><details class="rt-advanced"><summary>历史方案</summary><div id="reqHistory"></div></details></div>`;
      panel.querySelector('#reqClose').onclick=()=>panel.close();
      panel.querySelector('#reqForm').onsubmit=event=>{event.preventDefault();analyze();};
      panel.querySelector('#reqBrief').oninput=event=>{remember(event.target.value);showResult();};
    }
    panel.querySelector('#reqBrief').value=draft;
    showResult();panel.showModal();
    try { const status=await request('/api/status');history=list(status.analyses);renderHistory(); }
    catch { panel.querySelector('#reqHistory').innerHTML='<p class="rt-hint">本地服务就绪后可以读取历史方案。</p>'; }
    panel.querySelector('#reqBrief').focus();
  }
  document.addEventListener('click', event=>{
    const button=event.target.closest('[data-requirements]');
    if (!button) return;
    const source=button.dataset.requirements;
    open({brief:document.getElementById(source==='home'?'homeBrief':source==='task'?'rtBrief':'reqBrief')?.value || draft});
  });
  window.RequirementsUI=Object.freeze({open});
})();
