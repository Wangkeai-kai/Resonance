'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets metadata only: no Node.js, filesystem, commands, or generic IPC.
contextBridge.exposeInMainWorld('gongmingDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
}));

const isSplash = location.protocol === 'file:' && location.pathname.endsWith('/desktop/splash.html');
let latestState;

function renderState(state) {
  if (!isSplash || !state || typeof state !== 'object') return;
  latestState = state;
  const heading = document.getElementById('status-title');
  if (!heading) return;
  document.body.dataset.state = state.state === 'error' ? 'error' : 'loading';
  heading.textContent = String(state.title || '正在打开工作台');
  document.getElementById('status-detail').textContent = String(state.detail || '');
  document.getElementById('retry').hidden = state.state !== 'error';
  document.getElementById('splashDiagnostics').hidden = state.state !== 'error';
}

if (isSplash) ipcRenderer.on('desktop:state', (_event, state) => renderState(state));

window.addEventListener('DOMContentLoaded', () => {
  if (!isSplash) {
    const syncTheme=()=>ipcRenderer.send('desktop:theme',document.documentElement.dataset.theme==='dark'?'dark':'light');
    new MutationObserver(syncTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    syncTheme();
  }
  if (isSplash) {
    if (latestState) renderState(latestState);
    document.getElementById('retry')?.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      event.currentTarget.disabled = true;
      try { await ipcRenderer.invoke('desktop:retry'); }
      finally { const button = document.getElementById('retry'); if (button) button.disabled = false; }
    });
  }
  document.addEventListener('click', event => {
    if (event.isTrusted && event.button === 0 && event.target?.closest?.('#desktopDiagnostics,#splashDiagnostics')) {
      ipcRenderer.invoke('desktop:diagnostics').catch(() => {});
    }
    if (event.isTrusted && event.button === 0 && process.platform === 'win32' && event.target?.closest?.('#chatVoice')) {
      // Only the fixed dictation action is bridged, never arbitrary shell text.
      setTimeout(async () => {
        let ok = false;try { ok = await ipcRenderer.invoke('desktop:dictation'); } catch {}
        document.dispatchEvent(new CustomEvent('gongming:dictation', {detail:{ok}}));
      }, 80);
    }
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    try {
      const target = new URL(link.href, location.href);
      if (['https:', 'http:'].includes(target.protocol) && target.origin !== location.origin) {
        event.preventDefault();
        ipcRenderer.send('desktop:external-link', target.href);
      }
    } catch { /* Native navigation guards also reject invalid destinations. */ }
  }, true);
});
