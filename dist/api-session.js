(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const storageKey = 'resonance.api.session';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.get('session');
  if (supplied) history.replaceState(null, '', location.pathname + location.search);
  let saved = '';
  try {
    if (/^[a-f0-9]{64}$/.test(supplied || '')) sessionStorage.setItem(storageKey, supplied);
    saved = sessionStorage.getItem(storageKey) || '';
  } catch { saved = supplied || ''; }
  const token = window.gongmingDesktop?.sessionToken
    ? window.gongmingDesktop.sessionToken().catch(() => '')
    : Promise.resolve(saved);
  function showExpired() {
    if (document.getElementById('apiSessionNotice')) return;
    const show = () => {
      if (document.getElementById('apiSessionNotice')) return;
      const banner = document.createElement('p');
      banner.id = 'apiSessionNotice';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;z-index:99999;top:10px;left:20%;right:20%;padding:16px;border-radius:12px;background:#fff0d8;color:#573800;box-shadow:0 4px 20px #0003';
      banner.textContent = window.gongmingDesktop?.isDesktop
        ? '本地会话已失效，请关闭并重新打开 Resonance。已保存的工作仍在本地。'
        : '请使用启动终端显示的完整访问链接打开工作台。服务重启后需要使用新的链接。';
      document.body.append(banner);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, {once: true});
  }
  window.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input, location.href);
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const request = new Request(input instanceof Request ? input : target.href, init);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${await token}`);
    const response = await nativeFetch(new Request(request, {headers, redirect: 'error', cache: 'no-store'}));
    if (response.status === 401) showExpired();
    return response;
  };

  // <img> cannot set Authorization. Load protected attachments through fetch;
  // revoke each object URL when its message leaves the document.
  const images = new Map();
  async function loadImage(image) {
    if (images.has(image)) return;
    const controller = new AbortController();
    const record = {controller};
    images.set(image, record);
    try {
      const url = new URL(image.dataset.authSrc, location.href);
      if (url.origin !== location.origin || !/^\/api\/chats\/[^/]+\/attachments\//.test(url.pathname)) throw new Error();
      const response = await fetch(url.href, {signal: controller.signal});
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (controller.signal.aborted || !image.isConnected) return;
      record.url = URL.createObjectURL(blob);
      image.src = record.url;
    } catch { if (!controller.signal.aborted) image.alt = '图片暂时无法读取'; }
  }
  const visibility = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { visibility.unobserve(entry.target); loadImage(entry.target); }
  }, {rootMargin: '200px'}) : null;
  function scan() {
    for (const [image, record] of images) if (!image.isConnected) {
      record.controller.abort();
      if (record.url) URL.revokeObjectURL(record.url);
      visibility?.unobserve(image);
      images.delete(image);
    }
    for (const image of document.querySelectorAll('img[data-auth-src]')) {
      if (images.has(image)) continue;
      if (visibility) visibility.observe(image); else loadImage(image);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(scan).observe(document.body, {childList: true, subtree: true});
    scan();
  }, {once: true});

  window.ApiSession = Object.freeze({
    async preview(frame, html, scripts = false) {
      try {
        const response = await fetch('/api/previews', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({html, scripts})});
        if (!response.ok) throw new Error();
        const {url} = await response.json();
        if (frame.isConnected) frame.src = url;
      } catch {
        if (frame.isConnected) frame.srcdoc = '<p>预览暂时无法加载，请重新打开成果。</p>';
      }
    },
  });
})();
