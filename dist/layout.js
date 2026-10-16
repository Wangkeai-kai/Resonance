(() => {
  'use strict';
  const root = document.documentElement, sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const key = 'gongming.sidebar-width', desktop = matchMedia('(min-width:701px)');
  let preferred = null, drag = null;
  try { const value = Number(localStorage.getItem(key)); if (Number.isFinite(value) && value >= 220) preferred = value; } catch {}
  const handle = document.createElement('div');
  handle.id = 'sidebarResize'; handle.className = 'sidebar-resize'; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '调整侧栏宽度'); handle.title = '拖动调整宽度 · 双击恢复默认 · 方向键微调';
  document.body.append(handle);
  const limits = () => ({min:220, max:Math.max(220, Math.min(480, innerWidth - sidebar.getBoundingClientRect().left - 420))});
  const remember = () => { try { if (preferred === null) localStorage.removeItem(key); else localStorage.setItem(key, String(preferred)); } catch {} };
  function apply(value = preferred) {
    if (!desktop.matches) root.style.removeProperty('--nav');
    else if (value !== null) { const {min,max} = limits(); root.style.setProperty('--nav', Math.round(Math.max(min,Math.min(max,value))) + 'px'); }
    else root.style.removeProperty('--nav');
    const {min,max} = limits();
    handle.setAttribute('aria-valuemin', min); handle.setAttribute('aria-valuemax', max);
    handle.setAttribute('aria-valuenow', Math.round(sidebar.getBoundingClientRect().width));
  }
  function end(event) {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
    const id = drag.id; drag = null; document.body.classList.remove('sidebar-resizing');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    remember();
  }
  handle.addEventListener('pointerdown', event => {
    if (!desktop.matches || event.button !== 0) return;
    event.preventDefault(); drag = {id:event.pointerId,x:event.clientX,width:sidebar.getBoundingClientRect().width};
    handle.setPointerCapture(event.pointerId); document.body.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const {min,max} = limits(); preferred = Math.round(Math.max(min,Math.min(max,drag.width + event.clientX - drag.x))); apply();
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(type,end);
  handle.addEventListener('dblclick', () => { preferred = null; apply(); remember(); });
  handle.addEventListener('keydown', event => {
    if (!desktop.matches || !['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key)) return;
    event.preventDefault(); const {min,max} = limits();
    preferred = event.key === 'Enter' ? null : event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min,Math.min(max,sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 32 : 12)));
    apply(); remember();
  });
  window.addEventListener('resize', () => { end(); apply(); });
  window.addEventListener('blur', () => end());
  apply();
})();
