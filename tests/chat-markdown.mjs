import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const sandbox={module:{exports:{}},URL};
vm.runInNewContext(await fs.readFile(new URL('../dist/chat-markdown.js',import.meta.url),'utf8'),sandbox);
const {render,safeHref}=sandbox.module.exports;

test('headings, paragraphs, inline formatting and Chinese lists retain readable structure',()=>{
  const html=render('# 项目计划\n\n先确认 **目标**，再试 `npm test`。\n第二行。\n\n- 了解需求\n- 制作初稿\n  - 检查细节\n  - 更新说明\n\n3. 交付\n4. 审阅');
  assert.match(html,/<h2>项目计划<\/h2>/);assert.match(html,/<strong>目标<\/strong>/);assert.match(html,/<code>npm test<\/code>/);assert.match(html,/<br>第二行。/);
  assert.match(html,/<ul><li>了解需求<\/li><li>制作初稿<ul><li>检查细节/);assert.match(html,/<ol start="3"><li>交付<\/li><li>审阅<\/li><\/ol>/);
});

test('tables support aligned columns, escaped pipes and pipes inside code spans',()=>{
  const html=render('| 内容 | 状态 |\n| :--- | ---: |\n| `left|right` | 已完成 |\n| 说明\\|补充 | 等待确认 |');
  assert.match(html,/<table>/);assert.match(html,/<th scope="col" class="align-right">状态/);assert.match(html,/<code>left\|right<\/code>/);assert.match(html,/>说明\|补充<\/td>/);
  assert.equal((html.match(/<th /g)||[]).length,2);assert.equal((html.match(/<td /g)||[]).length,4);assert.match(html,/tabindex="0"/);
});

test('fenced code preserves contents as escaped text and exposes a copy control',()=>{
  const code='<script>alert("x")</script>\nconst value = "&";';
  const html=render('```javascript\n'+code+'\n```');
  assert.match(html,/data-chat-copy-code/);assert.match(html,/<span>javascript<\/span>/);assert.match(html,/&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);assert.ok(!html.includes('<script>'));
  assert.match(render('~~~html\n<strong>raw</strong>\n~~~'),/&lt;strong&gt;raw/);
  assert.match(render('```\n未闭合的代码'),/<code>未闭合的代码<\/code>/);
  assert.match(render('```"><img src=x>\nx\n```'),/<span>代码<\/span>/);
});

test('all raw HTML and attribute payloads stay text',()=>{
  const payloads=['<img src=x onerror="window.pwned=true">','<svg onload=alert(1)>','</code></pre><iframe srcdoc="<script>1</script>">','<a href="javascript:alert(1)">点我</a>','<style>body{display:none}</style>'];
  for(const payload of payloads){const html=render(payload);assert.ok(!/<(?:img|svg|iframe|script|style|a)\b/.test(html));assert.ok(html.includes('&lt;'));}
  assert.match(render('**<img src=x>**'),/<strong>&lt;img src=x&gt;<\/strong>/);
  assert.match(render('`<svg onload=x>`'),/<code>&lt;svg onload=x&gt;<\/code>/);
});

test('links allow only explicit HTTP(S) without controls, credentials or backslashes',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,hi','file:///C:/secret','//example.com','mailto:a@example.com','https:\\evil.test','https://user:pass@example.com','https://example.com/\nx','https://example.com/\u0000x'])assert.equal(safeHref(value),null,value);
  assert.equal(safeHref('https://example.test/文档'), 'https://example.test/%E6%96%87%E6%A1%A3');
  assert.match(render('[文档](https://example.test/docs?x=1&y=2)'),/href="https:\/\/example.test\/docs\?x=1&amp;y=2"/);
  assert.match(render('[文档](http://127.0.0.1:8080/docs)'),/href="http:\/\/127.0.0.1:8080\/docs"/);
  assert.match(render('[说明](https://example.test/wiki/Function_(math))'),/href="https:\/\/example.test\/wiki\/Function_\(math\)"/);
  assert.match(render('<https://example.test/docs>'),/rel="noopener noreferrer"/);
  for(const value of ['javascript:alert(1)','java&#x73;cript:alert(1)','data:text/html;base64,PHNjcmlwdD4=','file:///C:/secret','https://a:b@example.com'])assert.ok(!render(`[打开](${value})`).includes('<a '),value);
});

test('image Markdown never makes an image tag or outbound resource request',()=>{
  for(const url of ['https://tracker.example/pixel.png','data:image/svg+xml,<svg/onload=1>','javascript:alert(1)','/private-image']){
    const html=render(`![示例 <img onerror=x>](${url})`);assert.ok(!html.includes('<img'));assert.ok(!html.includes(' src='));assert.ok(!html.includes('<a '));assert.match(html,/未自动加载/);
  }
});

test('nested links cannot create nested anchors or inject attributes',()=>{
  const html=render('[<img onerror=x>](https://example.test/"onmouseover="x)\n[outer [inner](https://a.test)](https://b.test)');
  assert.ok(!html.includes(' onmouseover='));assert.ok(!html.includes('<img'));assert.ok(!/<a\b[^>]*>(?:(?!<\/a>).)*<a\b/.test(html));
});

test('quotes, tasks and malformed Markdown degrade safely; input is bounded',()=>{
  const html=render('> 一段说明\n> 第二行\n\n- [x] 已完成\n- [ ] 待检查\n\n***\n\n这是 **没有闭合 的提示。');
  assert.match(html,/<blockquote>/);assert.match(html,/type="checkbox" disabled checked[^>]*> 已完成/);assert.match(html,/type="checkbox" disabled [^>]*> 待检查/);assert.match(html,/<hr>/);assert.match(html,/\*\*没有闭合/);
  assert.match(render('很'.repeat(100001)),/内容较长/);assert.doesNotThrow(()=>render('[['.repeat(2000)+'`'.repeat(1000)));
});
