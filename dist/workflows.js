(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = value => Array.isArray(value) ? value : [];
  const stages = ['orchestrator','context','architect','developer','tester','docs','regression','git'];
  const statusNames = {completed:'已完成',running:'进行中',queued:'已排队',pending:'待开始',blocked:'等待前置步骤',failed:'失败',waiting_approval:'待审批',paused:'已暂停',interrupted:'已中断'};
  const icons = {ppt:'slides',website:'globe',document:'doc',project:'branch',code:'code'};
  let catalog = [], loading, panel;
  const request = async (url, body) => {
    const response = await fetch(url, {method:body === undefined ? 'GET':'POST',headers:body === undefined ? {Accept:'application/json'}:{'Content-Type':'application/json'},body:body === undefined ? undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(30000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || '工作流请求失败');
    return data;
  };
  const errorHtml = error => `<div class="rt-error" role="alert">${esc(error.name === 'TimeoutError' ? '等待超时，请刷新确认服务端结果后再操作。':error.message)}</div>`;
  async function load() {
    if (catalog.length) return catalog;
    if (!loading) loading = request('/api/workflows').then(data => catalog = list(data.workflows)).finally(()=>{loading=null;});
    return loading;
  }
  function modal(title, subtitle, content, wide=false) {
    if (panel) { panel.close();panel.remove(); }
    const dialog = document.createElement('dialog');dialog.className=`wf-dialog${wide?' wf-result-dialog':''}`;
    dialog.setAttribute('aria-label',title);
    dialog.innerHTML=`<div class="dialog-inner"><div class="dialog-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="icon-btn wf-close" aria-label="关闭工作流">×</button></div>${content}</div>`;
    dialog.querySelector('.wf-close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{if(panel===dialog)panel=null;dialog.remove();},{once:true});
    document.body.append(dialog);panel=dialog;dialog.showModal();return dialog;
  }
  const cards = () => catalog.map(item=>`<button type="button" class="wf-template wf-${esc(item.id)}" data-workflow="${esc(item.id)}"><span class="wf-template-icon"><svg aria-hidden="true"><use href="#i-${icons[item.id]||'doc'}"/></svg></span><strong>${esc(item.title)}</strong><p>${esc(item.description)}</p><span>查看流程与填写需求 →</span></button>`).join('');
  async function home() {
    const target=document.getElementById('workflowHome');if(!target)return;
    try {await load();target.innerHTML=`<div class="section-heading"><h2>工作流模板 <span>填写需求，让团队接着完成</span></h2><button type="button" class="text-link" data-workflows>全部工作流 →</button></div><div class="wf-catalog">${cards()}</div>`;}
    catch {target.innerHTML='<div class="section-heading"><h2>工作流模板</h2></div><p class="rt-hint">通过桌面应用或本地服务打开，即可使用完整工作流。</p><button type="button" class="outline-button" data-workflows>重新加载工作流</button>';}
  }
  async function open(workflowId, options = {}) {
    const dialog=modal('选择一个工作流','从需求到成果，按步骤完成并集中审阅。','<div id="wfCatalog">正在加载工作流…</div>');
    try {
      await load();if(!dialog.isConnected)return;
      const selected=catalog.find(item=>item.id===workflowId);
      if(selected){showForm(selected, options);return;}
      dialog.querySelector('#wfCatalog').innerHTML=`<div class="wf-catalog">${cards()}</div><p class="wf-note">工作流调用你已连接的模型。原有本地示例保留在首页，用于体验界面，不消耗 API。</p>`;
    }catch(error){if(dialog.isConnected)dialog.querySelector('#wfCatalog').innerHTML=errorHtml(error);}
  }
  function showForm(template, options = {}) {
    let draft={};try{draft=JSON.parse(sessionStorage.getItem(`gongming:workflow:${template.id}`)||'{}');}catch{}
    if(options.brief)draft.brief=options.brief;
    const values=draft.templateValues||{};
    const field = item => `<label class="wf-field">${esc(item.label)}${item.id==='slideCount'?`<input class="form-input" name="${esc(item.id)}" type="number" min="4" max="20" step="1" required value="${esc(values[item.id]??item.default??'8')}">`:`<textarea class="form-textarea" name="${esc(item.id)}" rows="${item.id==='materials'?4:2}" maxlength="${item.id==='materials'?12000:2000}" placeholder="${esc(item.placeholder)}">${esc(values[item.id]??item.default??'')}</textarea>`}</label>`;
    const dialog=modal(template.title,template.description,`<form id="wfCreateForm"><label class="wf-field">这次想完成什么？<textarea name="brief" class="form-textarea" minlength="3" maxlength="20000" required placeholder="说明主题、目标，以及一定要包含的内容">${esc(draft.brief||'')}</textarea></label><details class="wf-plan"><summary>更多设置 · 使用默认值即可开始</summary><div class="wf-fields">${template.fields.map(field).join('')}</div></details>${template.id==='code'?`<label class="wf-field">已有 Git 仓库路径<input class="form-input" name="projectPath" placeholder="C:\\Projects\\my-app" value="${esc(draft.projectPath||'')}"></label>`:''}<details class="wf-plan"><summary>完整工作流 · 8 个阶段</summary><ol>${template.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol><strong>你将得到</strong><ul>${template.deliverables.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></details><p class="wf-note">总协调先分析需求，再按依赖安排分工。遇到测试命令和版本操作会等待审批；最终成果由你审阅。${template.id==='code'?'':'无需自己建立 Git 仓库。'}</p><div class="task-model-entry"><span>使用已连接团队 · 总控统一调度</span><button type="button" class="text-link" data-manage-models>＋ 添加 / 管理模型</button></div><div id="wfCreateError" aria-live="polite"></div><div class="wf-actions"><button type="button" class="outline-button" data-workflows>选择其他模板</button><button type="submit" class="primary-button">开始此工作流</button></div></form>`);
    const form=dialog.querySelector('form');
    const read = () => ({brief:form.elements.brief.value,kind:template.kind,workflowId:template.id,templateValues:Object.fromEntries(template.fields.map(item=>[item.id,form.elements[item.id].value])),...(template.id==='code'?{projectPath:form.elements.projectPath.value}:{})});
    form.addEventListener('input',()=>{try{sessionStorage.setItem(`gongming:workflow:${template.id}`,JSON.stringify(read()));}catch{}});
    form.onsubmit=async event=>{
      event.preventDefault();if(!form.reportValidity())return;
      const draft=read();
      if(!window.RuntimeUI?.startTask){dialog.querySelector('#wfCreateError').innerHTML=errorHtml(new Error('任务工作区尚未就绪，请刷新应用。'));return;}
      dialog.close();await window.RuntimeUI.startTask(draft);
    };
    form.elements.brief.focus();
  }
  function progress(job) {
    if(!job.workflow)return '';
    return `<div class="wf-progress" aria-label="${esc(job.workflow.title)}工作流"><ol>${list(job.workflow.steps).map((label,index)=>{const task=list(job.tasks).find(t=>t.id===stages[index]);const status=task?.status||'pending';return `<li class="wf-step wf-step-${esc(status)}"><b>${index+1}</b><div><strong>${esc(label)}</strong><span>${esc(statusNames[status]||status)}</span></div></li>`;}).join('')}</ol>${job.status==='completed'?'<p>团队阶段已完成。请打开成果，检查内容、处理意见并确认定稿。</p>':''}</div>`;
  }
  function resultButton(job) {
    return job.deliverable?.artifact?`<button type="button" class="primary-button" data-workflow-result="${esc(job.id)}">${job.status==='completed'?'预览与审阅成果':'查看阶段成果'}</button>`:'';
  }
  function secureDocument(html, scripts) {
    const policy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scripts?"'unsafe-inline'":"'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';">`;
    // Prepend the policy so untrusted markup cannot load resources before it.
    return `<!doctype html><html><head><meta charset="utf-8">${policy}<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body>${html}</body></html>`;
  }
  async function openResult(id) {
    const dialog=modal('成果审阅','模型生成内容与人工修改版本保存在本机。','<div id="wfResultBody">正在读取成果…</div>',true);
    let snapshot, version=0, slide=0, busy=false;
    const body=dialog.querySelector('#wfResultBody');
    const current=()=>snapshot.review.versions[version].artifact;
    const latest=()=>version===snapshot.review.versions.length-1;
    const editable=()=>!!(snapshot.job.status==='completed'||snapshot.job.canReviewDraft)&&latest();
    async function reload(){
      try{snapshot=await request(`/api/jobs/${encodeURIComponent(id)}/result`);if(!dialog.isConnected)return;version=snapshot.review.versions.length-1;slide=Math.min(slide,(current().slides?.length||1)-1);draw();}
      catch(error){if(dialog.isConnected)body.innerHTML=`${errorHtml(error)}<button type="button" class="outline-button" id="wfRetryResult">重新读取</button>`;body.querySelector('#wfRetryResult')?.addEventListener('click',reload);}
    }
    async function save(action,extra={}){
      if(busy)return;busy=true;dialog.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);
      const failure=body.querySelector('#wfReviewError');failure.innerHTML='';
      try{const data=await request(`/api/jobs/${encodeURIComponent(id)}/review`,{action,sourceHash:snapshot.review.sourceHash,version:snapshot.review.versions.length,...extra});snapshot.review=data.review;version=data.review.versions.length-1;draw();await window.RuntimeUI?.refresh();}
      catch(error){failure.innerHTML=errorHtml(error);}
      finally{busy=false;if(dialog.isConnected){dialog.querySelector('.wf-close').disabled=false;restoreControls();}}
    }
    function restoreControls(){
      body.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);
      body.querySelectorAll('[data-wf-mutate]').forEach(el=>el.disabled=!editable());
      const approve=body.querySelector('#wfApprove');if(approve)approve.disabled=snapshot.job.status!=='completed'||!editable()||snapshot.review.approved||snapshot.review.comments.some(c=>!c.resolved);
      body.querySelector('#wfPrevious')?.toggleAttribute('disabled',slide===0);
      body.querySelector('#wfNext')?.toggleAttribute('disabled',slide===(current().slides?.length||1)-1);
    }
    function showPreview(){
      const artifact=current(),target=body.querySelector('#wfPreview');target.replaceChildren();
      if(artifact.kind==='ppt'||artifact.kind==='website'){
        const frame=document.createElement('iframe');frame.className=artifact.kind==='ppt'?'wf-slide-frame':'wf-site-frame';frame.title=artifact.kind==='ppt'?`第 ${slide+1} 页幻灯片预览`:'网站隔离预览';
        frame.setAttribute('sandbox',artifact.kind==='website'?'allow-scripts':'');frame.referrerPolicy='no-referrer';
        frame.srcdoc=secureDocument(artifact.kind==='ppt'?window.ArtifactEngine.slideHtml(artifact.slides[slide],slide,artifact.slides.length):artifact.html,artifact.kind==='website');target.append(frame);
      }else{const pre=document.createElement('pre');pre.className='wf-markdown';pre.textContent=artifact.markdown||artifact.code||JSON.stringify(artifact,null,2);target.append(pre);}
      if(artifact.kind==='ppt')body.querySelector('#wfPageLabel').textContent=`第 ${slide+1} / ${artifact.slides.length} 页`;
      body.querySelector('#wfCommentLabel').textContent=artifact.kind==='ppt'?`给第 ${slide+1} 页提意见`:'审阅意见';
      restoreControls();
    }
    function draw(){
      if(!dialog.isConnected)return;
      const {job,review}=snapshot,artifact=current();
      body.innerHTML=`<div class="wf-result-heading"><div><h3>${esc(artifact.title)}</h3><span>${review.approved&&latest()?'已确认定稿':'待人工审阅'} · V${version+1}${job.status==='completed'?'':job.canReviewDraft?' · 初稿可修改与导出，验收待完善':' · 任务尚未完成，仅可预览'}</span></div><button type="button" class="outline-button" id="wfReload">刷新成果</button></div><div class="wf-review-toolbar"><label>版本<select class="form-input" id="wfVersion">${review.versions.map((item,i)=>`<option value="${i}" ${i===version?'selected':''}>V${i+1} · ${esc(item.note)}</option>`).join('')}</select></label><button type="button" class="outline-button" id="wfExport">导出当前版本</button><button type="button" class="primary-button" id="wfApprove" data-wf-mutate>确认定稿</button></div><p class="wf-note">${job.reviewRequired?'初稿已生成，模型验收仍有缺项；请先核对这些内容，导出不代表已经验收通过。':''}${artifact.kind==='website'?'预览在隔离环境中运行，网络请求与表单提交已禁用。':''}${latest()?'未定稿版本也可导出；导出不代表人工验收通过。':'正在查看历史版本。切回最新版本后可添加意见或修改。'}</p><div id="wfPreview" class="wf-preview"></div>${artifact.kind==='ppt'?`<div class="wf-slide-controls"><button type="button" class="outline-button" id="wfPrevious">上一页</button><span id="wfPageLabel"></span><button type="button" class="outline-button" id="wfNext">下一页</button><button type="button" class="outline-button" id="wfEditSlide" data-wf-mutate>编辑这一页</button></div>`:''}<div id="wfEditor"></div><div id="wfReviewError" aria-live="polite"></div><section class="wf-comments"><h3>审阅意见 <span>${review.comments.filter(c=>!c.resolved).length} 条待处理</span></h3><form id="wfCommentForm"><label id="wfCommentLabel" for="wfComment"></label><textarea id="wfComment" class="form-textarea" required maxlength="2000" placeholder="指出需要修改的内容或补充的依据" data-wf-mutate></textarea><button type="submit" class="outline-button" data-wf-mutate>添加意见</button></form><div>${review.comments.length?review.comments.map(comment=>`<article class="wf-comment ${comment.resolved?'wf-resolved':''}"><div><button class="text-link" type="button" data-wf-anchor="${comment.slide}">${artifact.kind==='ppt'?`第 ${comment.slide+1} 页`:'正文'} · V${comment.version}</button><p>${esc(comment.text)}</p></div><button type="button" class="outline-button" data-wf-resolve="${esc(comment.id)}" data-wf-mutate>${comment.resolved?'重新打开':'标记已处理'}</button></article>`).join(''):'<p class="wf-note">还没有审阅意见。</p>'}</div></section><details class="wf-plan"><summary>结构检查与验收边界</summary><ul>${list(job.checks).map(c=>`<li>${esc(c.evidence)}</li>`).join('')}${list(job.limitations).map(c=>`<li>${esc(c)}</li>`).join('')}</ul></details>${review.versions.length>1?`<details class="wf-plan"><summary>与上一版本对照</summary><div class="wf-compare"><div><strong>V${Math.max(1,version)}</strong><pre>${esc(JSON.stringify(review.versions[Math.max(0,version-1)].artifact,null,2))}</pre></div><div><strong>V${version+1}</strong><pre>${esc(JSON.stringify(artifact,null,2))}</pre></div></div></details>`:''}`;
      body.querySelector('#wfReload').onclick=reload;
      body.querySelector('#wfVersion').onchange=event=>{version=Number(event.target.value);slide=Math.min(slide,(current().slides?.length||1)-1);draw();};
      body.querySelector('#wfApprove').onclick=()=>save('approve');
      body.querySelector('#wfExport').onclick=async()=>{try{await window.ArtifactEngine.download(current());}catch(error){body.querySelector('#wfReviewError').innerHTML=errorHtml(error);}};
      body.querySelector('#wfCommentForm').onsubmit=event=>{event.preventDefault();if(editable())save('comment',{text:body.querySelector('#wfComment').value,slide});};
      body.querySelectorAll('[data-wf-resolve]').forEach(button=>button.onclick=()=>{const comment=review.comments.find(c=>c.id===button.dataset.wfResolve);save('resolve',{commentId:comment.id,resolved:!comment.resolved});});
      body.querySelectorAll('[data-wf-anchor]').forEach(button=>button.onclick=()=>{slide=Number(button.dataset.wfAnchor);showPreview();body.querySelector('#wfPreview').scrollIntoView({block:'center',behavior:'smooth'});});
      if(artifact.kind==='ppt'){
        body.querySelector('#wfPrevious').onclick=()=>{slide=Math.max(0,slide-1);body.querySelector('#wfEditor').innerHTML='';showPreview();};
        body.querySelector('#wfNext').onclick=()=>{slide=Math.min(artifact.slides.length-1,slide+1);body.querySelector('#wfEditor').innerHTML='';showPreview();};
        body.querySelector('#wfEditSlide').onclick=editSlide;
      }
      showPreview();
    }
    function editSlide(){
      if(!editable())return;const page=current().slides[slide],index=slide,target=body.querySelector('#wfEditor');
      target.innerHTML=`<form class="wf-editor" id="wfEditForm"><h3>修改第 ${slide+1} 页</h3><label class="wf-field">标题<input name="title" class="form-input" required maxlength="64" value="${esc(page.title)}"></label><label class="wf-field">副标题<input name="subtitle" class="form-input" maxlength="100" value="${esc(page.subtitle)}"></label>${slide>0?`<label class="wf-field">版式<select name="layout" class="form-input">${[["editorial","分项说明"],["comparison","两项对照"],["process","步骤流程"],["focus","单一重点"]].filter(([id])=>id==="editorial"||id==="comparison"&&page.items.length===2||id==="process"&&page.items.length>=2||id==="focus"&&page.items.length===1).map(([id,label])=>`<option value="${id}" ${page.layout===id?"selected":""}>${label}</option>`).join("")}</select></label>`:""}${page.items.map((item,i)=>`<div class="wf-fields"><label class="wf-field">内容 ${i+1} 标题<input name="item-title-${i}" class="form-input" required maxlength="40" value="${esc(item.title)}"></label><label class="wf-field">内容 ${i+1} 正文<textarea name="item-body-${i}" class="form-textarea" required maxlength="100">${esc(item.body)}</textarea></label></div>`).join('')}<p class="wf-note">保存会创建新版本，并取消此前的定稿状态。原始模型成果仍保留。</p><div class="wf-actions"><button type="button" class="outline-button" id="wfCancelEdit">取消</button><button type="submit" class="primary-button">保存为新版本</button></div></form>`;
      target.querySelector('#wfCancelEdit').onclick=()=>target.replaceChildren();
      target.querySelector('form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;save('edit-slide',{slide:index,content:{title:form.elements.title.value,subtitle:form.elements.subtitle.value,...(form.elements.layout?{layout:form.elements.layout.value}:{}),items:page.items.map((_,i)=>({title:form.elements[`item-title-${i}`].value,body:form.elements[`item-body-${i}`].value}))}});};
    }
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    await reload();
  }
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-workflows],[data-workflow],[data-workflow-result]');if(!trigger)return;
    if(trigger.hasAttribute('data-workflow-result'))openResult(trigger.dataset.workflowResult);
    else open(trigger.dataset.workflow);
  });
  window.WorkflowsUI=Object.freeze({open,openResult,progress,resultButton,onTaskCreated:job=>{if(job?.workflow)window.Gongming?.toast('任务已开始，进展会出现在对话中。');}});
  home();
})();
