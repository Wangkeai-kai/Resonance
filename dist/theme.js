(() => {
  const key = 'gongming.appearance';
  let mode = 'light';
  try { mode = localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; } catch {}
  const apply = () => {
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#222326' : '#f6f7f9');
    const button = document.getElementById('themeToggle');
    if (button) {
      const label = mode === 'dark' ? '浅色' : '深色';
      button.querySelector('span').textContent = label;
      button.setAttribute('aria-label', `切换到${label}主题`);
      button.title = `切换到${label}主题`;
    }
  };
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      mode = mode === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, mode); } catch {}
      apply();
    });
  });
  window.addEventListener('storage', event => {
    if (event.key === key) { mode = event.newValue === 'dark' ? 'dark' : 'light'; apply(); }
  });
})();
