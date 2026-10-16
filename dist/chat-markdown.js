(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MAX_LENGTH = 100000;
  function safeHref(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value) || !/^https?:\/\//i.test(value)) return null;
    try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  const anchor = (url, label) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  function linkAt(text, start) {
    const image = text[start] === '!', open = start + (image ? 1 : 0);
    if (text[open] !== '[') return null;
    let close = open + 1, brackets = 1;
    for (; close < Math.min(text.length, open + 2048); close++) {
      if (text[close] === '\\') { close++; continue; }
      if (text[close] === '[' && ++brackets > 8) return null;
      if (text[close] === ']' && --brackets === 0) break;
      // A label may contain plain brackets, but never spans lines.
      if (text[close] === '\n') return null;
    }
    if (brackets || text[close + 1] !== '(') return null;
    let end = close + 2, parentheses = 1;
    for (; end < Math.min(text.length, close + 4096); end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(' && ++parentheses > 8) return null;
      if (text[end] === ')' && --parentheses === 0) break;
      if (text[end] === '\n') return null;
    }
    if (parentheses) return null;
    let destination = text.slice(close + 2, end).trim();
    destination = destination.replace(/\s+["'][^\r\n]*["']$/, '');
    if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
    destination = destination.replace(/\\([()])/g, '$1');
    return {image, label:text.slice(open + 1, close), destination, end:end + 1};
  }
  function inline(text, depth = 0) {
    if (depth > 6) return escape(text);
    let html = '', plain = '', i = 0;
    const flush = () => { html += escape(plain); plain = ''; };
    while (i < text.length) {
      if (text[i] === '\\' && /[\\`*_[\]{}()#+.!|>~-]/.test(text[i + 1] || '')) { plain += text[i + 1]; i += 2; continue; }
      if (text[i] === '`') {
        const marker = text.slice(i).match(/^`+/)[0], end = text.indexOf(marker, i + marker.length);
        if (end >= 0) { flush(); html += `<code>${escape(text.slice(i + marker.length, end).replace(/\n/g, ' '))}</code>`; i = end + marker.length; continue; }
      }
      if (text[i] === '[' || text.startsWith('![', i)) {
        const link = linkAt(text, i);
        if (link) {
          const href = safeHref(link.destination); flush();
          // Images stay as text: model output never causes a remote image request.
          html += link.image ? `<span class="chat-image-reference">[图片：${escape(link.label || '图片附件')}，未自动加载]</span>` : href ? anchor(href, inline(link.label, depth + 1).replace(/<a\b[^>]*>|<\/a>/g, '')) : escape(text.slice(i, link.end));
          i = link.end; continue;
        }
      }
      const marker = ['**','__','~~','*','_'].find(token => text.startsWith(token, i) && (token !== '_' || !/[\p{L}\p{N}]/u.test(text[i - 1] || '')));
      if (marker) {
        const end = text.indexOf(marker, i + marker.length);
        if (end > i + marker.length && !/\s/.test(text[i + marker.length]) && !/\s/.test(text[end - 1])) {
          const tag = marker.length === 2 ? marker === '~~' ? 'del' : 'strong' : 'em';
          flush(); html += `<${tag}>${inline(text.slice(i + marker.length, end), depth + 1)}</${tag}>`; i = end + marker.length; continue;
        }
      }
      if (text[i] === '<') {
        const end = text.indexOf('>', i + 1), url = end >= 0 ? safeHref(text.slice(i + 1, end)) : null;
        if (url) { flush(); html += anchor(url, escape(text.slice(i + 1, end))); i = end + 1; continue; }
      }
      if ((i === 0 || /[\s（(]/.test(text[i - 1])) && /^https?:\/\//i.test(text.slice(i, i + 8))) {
        const match = text.slice(i).match(/^https?:\/\/[^\s<>"'`]+/i);
        if (match) {
          let value = match[0].replace(/[.,!?;:。！，？；：]+$/, '');
          while (value.endsWith(')') && (value.match(/\)/g) || []).length > (value.match(/\(/g) || []).length) value = value.slice(0, -1);
          const url = safeHref(value); if (url) { flush(); html += anchor(url, escape(value)); i += value.length; continue; }
        }
      }
      plain += text[i++];
    }
    flush(); return html;
  }
  function cells(line) {
    let value = line.trim(); if (value.startsWith('|')) value = value.slice(1); if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const result = []; let cell = '', code = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\\' && i + 1 < value.length) { cell += value[i] + value[++i]; continue; }
      if (value[i] === '`') { const run = value.slice(i).match(/^`+/)[0].length; code = code === run ? 0 : code || run; cell += '`'.repeat(run); i += run - 1; continue; }
      if (value[i] === '|' && !code) { result.push(cell.trim()); cell = ''; } else cell += value[i];
    }
    result.push(cell.trim()); return result;
  }
  const listItem = line => line.match(/^([ \t]*)([-+*]|\d{1,6}[.)])\s+(.+)$/);
  const fence = line => line.match(/^ {0,3}(`{3,}|~{3,})\s*(.*)$/);
  const tableDivider = line => line?.includes('|') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));
  const startsBlock = (lines, index) => !lines[index]?.trim() || fence(lines[index]) || /^ {0,3}#{1,6}\s+/.test(lines[index]) || listItem(lines[index]) || /^\s*>/.test(lines[index]) || /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index]) || tableDivider(lines[index + 1]);
  function blocks(lines, depth = 0) {
    if (depth > 6) return `<p>${escape(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
    let html = '', i = 0;
    while (i < lines.length) {
      const line = lines[i]; if (!line.trim()) { i++; continue; }
      const fenced = fence(line);
      if (fenced) {
        const marker = fenced[1], code = []; i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        const language = /^[\w+#.-]{1,32}$/.test(fenced[2]) ? fenced[2] : '代码';
        const source=code.join('\n'),highlighted=typeof window!=='undefined'&&window.CodeHighlight?window.CodeHighlight.highlight(source,language):escape(source);
        html += `<div class="chat-code-block"><div class="chat-code-heading"><span>${escape(language)}</span><button type="button" data-chat-copy-code aria-label="复制代码">复制代码</button></div><pre><code>${highlighted}</code></pre></div>`; continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) { const level = Math.min(heading[1].length + 1, 6); html += `<h${level}>${inline(heading[2])}</h${level}>`; i++; continue; }
      if (tableDivider(lines[i + 1]) && line.includes('|')) {
        const headers = cells(line).slice(0, 20), separators = cells(lines[i + 1]), align = separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
        html += `<div class="chat-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0"><table><thead><tr>${headers.map((cell, j) => `<th scope="col" class="align-${align[j] || 'left'}">${inline(cell)}</th>`).join('')}</tr></thead><tbody>`; i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !fence(lines[i])) { const row = cells(lines[i++]); html += `<tr>${headers.map((_, j) => `<td class="align-${align[j] || 'left'}">${inline(row[j] || '')}</td>`).join('')}</tr>`; }
        html += '</tbody></table></div>'; continue;
      }
      const item = listItem(line);
      if (item) {
        const ordered = /^\d/.test(item[2]), tag = ordered ? 'ol' : 'ul', indent = item[1].replace(/\t/g, '    ').length, start = ordered ? Number.parseInt(item[2], 10) : 1;
        html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
        while (i < lines.length) {
          const next = listItem(lines[i]); if (!next || /^\d/.test(next[2]) !== ordered || next[1].replace(/\t/g, '    ').length !== indent) break;
          const nested = []; let text = next[3]; i++;
          while (i < lines.length && lines[i].trim() && /^\s/.test(lines[i]) && lines[i].match(/^\s*/)[0].replace(/\t/g, '    ').length > indent) nested.push(lines[i++].replace(new RegExp(`^ {0,${indent + 2}}`), ''));
          const checkbox = text.match(/^\[([ xX])\]\s+(.+)$/);
          html += `<li>${checkbox?`<input class="markdown-task" type="checkbox" disabled ${checkbox[1]===' '?'':'checked'} aria-label="${checkbox[1]===' '?'未完成':'已完成'}"> ${inline(checkbox[2])}`:inline(text)}${nested.length ? blocks(nested, depth + 1) : ''}</li>`;
        }
        html += `</${tag}>`; continue;
      }
      if (/^\s*>/.test(line)) { const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, '')); html += `<blockquote>${blocks(quote, depth + 1)}</blockquote>`; continue; }
      if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
      const paragraph = [line]; i++; while (i < lines.length && !startsBlock(lines, i)) paragraph.push(lines[i++]); html += `<p>${paragraph.map(part => inline(part)).join('<br>')}</p>`;
    }
    return html;
  }
  function render(value) { const text = String(value ?? ''); return blocks(text.slice(0, MAX_LENGTH).replace(/\r\n?/g, '\n').split('\n')) + (text.length > MAX_LENGTH ? '<p class="chat-context-note">内容较长，超出部分未在此展开。</p>' : ''); }
  const api = Object.freeze({render, safeHref});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ChatMarkdown = api;
})();
