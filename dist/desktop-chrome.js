(() => {
  if(!window.gongmingDesktop?.isDesktop)return;
  document.body.dataset.desktop='true';
  const bar=document.createElement('header');bar.className='desktop-titlebar';bar.innerHTML='<button data-view="discover" aria-label="返回工作台" title="返回工作台">←</button><span class="desktop-title">Resonance <small>本地工作台</small></span><span class="desktop-local">本地</span>';
  document.body.prepend(bar);
  const logs=document.createElement('button');logs.type='button';logs.id='desktopDiagnostics';logs.className='nav-item';logs.textContent='诊断日志';logs.title='打开本机日志文件夹；不包含原始对话或 API 密钥';document.querySelector('.workspace-tools')?.append(logs);
})();
