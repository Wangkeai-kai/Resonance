(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArtifactEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NOTICE = '本地模板演示';
  var DISCLAIMER = '内容由本地模板填充，未调用 AI；目标、计划及文案均为示例，请按实际情况修改。';
  var encoder = new TextEncoder();
  function clean(value) { return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''); }
  function escape(value) { return clean(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cut(value, max) { var a = Array.from(clean(value)); return a.length > max ? a.slice(0, max).join('') + '…' : a.join(''); }
  function titleFor(brief, fallback) { return cut(clean(brief).split(/\r?\n/).find(function (s) { return s.trim(); }) || fallback, 36).trim(); }
  function filename(value) { return cut(clean(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/g, ''), 50) || '协作产物'; }

  function create(kind, brief) {
    if (['ppt', 'website', 'code', 'document', 'project'].indexOf(kind) < 0) throw new Error('不支持的产物类型：' + kind);
    var title = titleFor(brief, kind === 'ppt' ? '让想法成为下一步' : kind === 'website' ? '为下一个想法，留一点空间' : kind === 'document' ? '我的任务文档' : kind === 'project' ? '项目执行计划' : '我的任务工作台');
    var artifact = { title: title, kind: kind, brief: clean(brief), notice: NOTICE, summary: DISCLAIMER };
    if (kind === 'ppt') artifact.slides = makeSlides(title, brief);
    if (kind === 'website') artifact.html = makeWebsite(title, brief);
    if (kind === 'code') artifact.code = makeTodo(title);
    if (kind === 'document' || kind === 'project') artifact.markdown = makeMarkdown(kind, title, brief);
    return artifact;
  }

  function makeMarkdown(kind, title, brief) {
    var safeTitle = clean(title).replace(/[\r\n]/g, ' ');
    var quotedBrief = (clean(brief).trim() || '待补充具体任务需求。').split(/\r?\n/).map(function (line) { return '> ' + line; }).join('\n');
    var heading = '# ' + safeTitle + '\n\n> 本地模板演示。以下内容是待编辑的示例草稿，未调用 AI，也不代表任务已完成。\n\n';
    if (kind === 'document') return heading + '## 任务目标\n\n' + quotedBrief + '\n\n- 使用对象：待确认\n- 交付形式：待确认\n- 截止时间：待确认\n\n## 内容草稿\n\n### 背景\n\n在这里补充任务产生的背景与现有资料。仅使用已核实的信息。\n\n### 主要内容\n\n1. 说明需要解决的问题。\n2. 整理可用资料，标明资料来源。\n3. 给出可讨论的初步方案，区分事实与假设。\n\n### 下一步\n\n确认内容结构后，再补齐事实依据并完善表达。\n\n## 待确认\n\n- [ ] 目标与受众是否明确\n- [ ] 引用的数据与来源是否真实\n- [ ] 是否包含必要的边界与限制\n- [ ] 谁负责最终审阅\n\n## 修改记录\n\n- 初始版本：本地模板，等待编辑与确认。\n';
    return heading + '## 项目目标\n\n' + quotedBrief + '\n\n- 项目状态：待启动\n- 项目负责人：待指定\n- 计划时间：待安排\n\n## 工作包\n\n| 工作包 | 工作内容 | 负责人 | 状态 |\n| --- | --- | --- | --- |\n| 需求确认 | 明确对象、范围与约束 | 待指定 | 未开始 |\n| 资料整理 | 收集资料并标注来源 | 待指定 | 未开始 |\n| 初稿制作 | 按已确认的要求制作初稿 | 待指定 | 未开始 |\n| 联合评审 | 核对事实并记录待修改项 | 待指定 | 未开始 |\n| 最终交付 | 完成修订，检查文件与版本 | 待指定 | 未开始 |\n\n## 交付物\n\n- [ ] 需求与验收清单\n- [ ] 可编辑的成果初稿\n- [ ] 评审意见与修改记录\n- [ ] 最终成果文件\n\n## 验收标准\n\n- 交付内容覆盖已确认的需求。\n- 事实、数据与引用有可核实来源。\n- 文档或文件可正常打开，内容可继续编辑。\n- 未解决的问题有明确说明和后续安排。\n\n## 依赖与待确认\n\n- [ ] 输入资料是否齐全\n- [ ] 成员分工与时间是否确认\n- [ ] 外部依赖是否可用\n- [ ] 验收人和最终格式是否确定\n\n## 项目记录\n\n当前为本地模板生成的执行计划，所有工作包尚未开始。\n';
  }

  function makeSlides(title, brief) {
    var context = cut(clean(brief).trim(), 135) || '围绕一个明确问题，形成可讨论、可调整的行动方案。';
    return [
      { type: 'cover', kicker: 'IDEAS, IN GOOD COMPANY', title: title, subtitle: '一份可以继续打磨的项目提案', items: [], footer: NOTICE + ' · 5 页可编辑演示文稿' },
      { type: 'goals', kicker: '01 / PURPOSE', title: '目标与边界', subtitle: '先明确要解决什么，再决定如何推进', items: [
        { title: '项目背景', body: context },
        { title: '预期成果', body: '形成一份可评审的初稿，并明确下一步需要补齐的内容。' },
        { title: '待验证的信息', body: '目标用户、使用场景和验收标准需要确认。此演示不包含真实调研数据。' }
      ], footer: NOTICE + ' · 目标与判断均待确认' },
      { type: 'strategy', kicker: '02 / APPROACH', title: '协作策略', subtitle: '围绕同一份需求，分工产出，再统一审阅', items: [
        { title: '明确分工', body: '策划梳理结构，内容角色整理材料，设计角色负责呈现。' },
        { title: '按需共享', body: '每个角色获取完成任务所需的材料，交接时保留关键结论和引用。' },
        { title: '统一验收', body: '汇总成一份可编辑成果，检查内容一致性、表达和使用体验。' }
      ], footer: NOTICE + ' · 协作方案示例' },
      { type: 'milestones', kicker: '03 / NEXT STEPS', title: '阶段与交付物', subtitle: '以下是建议顺序，实际时间由项目安排决定', items: [
        { title: '01  需求确认', body: '确认对象、交付形式与验收清单。' },
        { title: '02  初稿制作', body: '整理大纲，完成第一份内容和视觉草稿。' },
        { title: '03  联合评审', body: '检查事实依据，记录分歧并修订。' },
        { title: '04  完成交付', body: '检查最终文件，记录版本和待办事项。' }
      ], footer: NOTICE + ' · 阶段计划示例，无承诺日期' },
      { type: 'closing', kicker: '04 / KEEP IT MOVING', title: '下一步，从一份可用初稿开始', subtitle: '确认范围后，补齐资料与验收标准，再进入制作。', items: [
        { title: '需要补齐', body: '真实资料、明确受众、具体交付要求。' },
        { title: '下一次评审', body: '重点讨论内容是否完整，以及哪些信息还需要核实。' }
      ], footer: NOTICE + ' · 未调用 AI，未进行真实调研' }
    ];
  }

  function makeWebsite(title, brief) {
    var t = escape(title), b = escape(cut(clean(brief).trim() || '一个想法的开始，也可以是一段精彩旅程的开始。', 260));
    return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + t + '</title><style>\n' +
      '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f8f7f4;color:#252724;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}a{color:inherit;text-decoration:none}nav{max-width:1160px;margin:auto;padding:26px 30px;display:flex;align-items:center;gap:32px}.brand{font-size:18px;font-weight:750;letter-spacing:-.7px;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mark{display:inline-grid;place-items:center;width:29px;height:29px;background:#d9443e;color:white;border-radius:50%;margin-right:8px}nav .links{margin-left:auto;display:flex;align-items:center;gap:25px;font-size:13px}.nav-cta{border:1px solid #d9dbd5;padding:10px 18px;border-radius:24px}.hero{max-width:1160px;min-height:540px;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;gap:55px;margin:auto;padding:60px 30px 80px}.eyebrow{color:#ba463e;font-size:11px;letter-spacing:2px;font-weight:750;text-transform:uppercase}.hero h1{font-size:clamp(32px,4.5vw,58px);line-height:1.17;letter-spacing:-2px;margin:22px 0;overflow-wrap:anywhere}.hero p{font-size:15px;line-height:1.9;color:#777b73;max-width:470px;white-space:pre-line;overflow-wrap:anywhere}.button{display:inline-block;border:0;font:inherit;font-size:13px;cursor:pointer;border-radius:28px;padding:15px 24px;background:#d9443e;color:#fff;margin-top:21px}.button.secondary{background:transparent;color:#565b50;margin-left:12px}.art{aspect-ratio:1;border-radius:46% 46% 44% 44%;background:#e8ece1;position:relative;overflow:hidden;display:grid;place-items:center}.orbit{width:76%;aspect-ratio:1;border:1px solid #bcc4b2;border-radius:50%;position:absolute}.orbit:before{content:"";display:block;width:20px;height:20px;background:#d9443e;border-radius:50%;position:absolute;left:7%;top:16%}.orbit.two{width:53%;transform:rotate(120deg)}.center{width:34%;aspect-ratio:1;border-radius:30%;background:#a8b593;box-shadow:0 28px 50px #576d421f;transform:rotate(-15deg);display:grid;place-items:center}.center span{font-size:60px;color:#f8f7f4;transform:rotate(15deg)}.art-label{position:absolute;bottom:14%;font-size:10px;color:#69725f;letter-spacing:2px}.section{max-width:1160px;margin:auto;padding:65px 30px}.section h2{font-size:32px;letter-spacing:-1px;margin:12px 0}.intro{color:#7c8078;font-size:14px;line-height:1.8}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:40px}.card{padding:28px 0;border-top:1px solid #d9dcd4}.num{font-size:12px;color:#a2a898}.card h3{font-size:20px;margin:21px 0 13px}.card p{color:#7c8078;line-height:1.9;font-size:14px}.contact{background:#e9ece3;text-align:center;border-radius:24px;padding:56px 25px;margin:20px 30px 70px}.contact h2{font-size:30px;letter-spacing:-1px}.contact p{color:#747c6b;font-size:14px}.contact-note{font-size:12px!important;min-height:19px}.footer{padding:25px 30px;border-top:1px solid #e0e2dc;max-width:1100px;margin:auto;display:flex;justify-content:space-between;gap:20px;font-size:11px;color:#92968c}.demo{position:fixed;bottom:15px;right:15px;border:1px solid #e1e1db;background:#fffffff0;color:#85897e;border-radius:18px;padding:7px 11px;font-size:10px;backdrop-filter:blur(12px)}@media(max-width:720px){nav{padding:22px}.hero{grid-template-columns:1fr;padding:30px 22px;gap:35px}.hero h1{letter-spacing:-1px}.art{max-width:360px;width:100%;margin:auto}.section{padding:45px 22px}.cards{grid-template-columns:1fr;gap:0}nav .links a:not(.nav-cta){display:none}.contact{margin:15px 22px 40px}.footer{padding:25px 22px;flex-direction:column}}\n' +
      '</style></head><body><nav><a class="brand" href="#"><span class="mark">✳</span>' + t + '</a><div class="links"><a href="#about">关于</a><a href="#features">特色</a><a class="nav-cta" href="#contact">联系合作 ↗</a></div></nav><main><section class="hero" id="about"><div><div class="eyebrow">A small idea. A new beginning.</div><h1>' + t + '</h1><p>' + b + '</p><a class="button" href="#features">探索更多 <span aria-hidden="true">↗</span></a><a class="button secondary" href="#contact">聊聊你的想法</a></div><div class="art" role="img" aria-label="绿色圆环与红色圆点构成的抽象插画"><div class="orbit"></div><div class="orbit two"></div><div class="center"><span>✳</span></div><span class="art-label">MADE FOR YOUR NEXT IDEA</span></div></section><section class="section" id="features"><div class="eyebrow">Thoughtfully made</div><h2>把每一个想法，好好呈现。</h2><p class="intro">从清晰的表达开始，让内容与体验自然相连。以下为示例网站文案。</p><div class="cards"><article class="card"><span class="num">01 / CLEAR</span><h3>简洁而清晰</h3><p>保留最重要的信息，让访客更快理解你的想法与方向。</p></article><article class="card"><span class="num">02 / CONSIDERED</span><h3>细节有温度</h3><p>柔和的配色和舒适的留白，让每一次浏览都有自己的节奏。</p></article><article class="card"><span class="num">03 / YOURS</span><h3>留给你更多可能</h3><p>这份独立网页可以下载和继续编辑。替换文案，就能开始自己的故事。</p></article></div></section><section class="section"><div class="contact" id="contact"><div class="eyebrow">Let’s make something</div><h2>你的下一步，从这里开始。</h2><p>补充真实联系信息后，即可将这里作为合作入口。</p><button class="button" id="contact-button" type="button">了解合作方式 ↗</button><p class="contact-note" id="contact-note" role="status"></p></div></section></main><footer class="footer"><span>' + t + '</span><span>' + NOTICE + ' · 未发布 · 联系入口为示例</span></footer><div class="demo">' + NOTICE + '</div><script>document.getElementById("contact-button").addEventListener("click",function(){document.getElementById("contact-note").textContent="这是本地模板演示，请编辑 HTML 后填入你的真实联系信息。";});</script></body></html>';
  }

  function makeTodo(title) {
    return '<!doctype html>\n<!-- 本地模板演示：无需依赖的 TODO 应用。保存为 index.html 并在浏览器中打开。未调用 AI。 -->\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style>\n' +
      '*{box-sizing:border-box}body{margin:0;background:#f6f6f7;color:#292a30;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:650px;margin:70px auto;padding:34px;background:#fff;border:1px solid #eeeef0;border-radius:20px}h1{margin:12px 0 8px;font-size:29px;overflow-wrap:anywhere}.muted{color:#93939d;font-size:12px}form{display:flex;gap:10px;margin:28px 0}input[type=text]{flex:1;min-width:0;border:1px solid #dedee3;border-radius:10px;padding:12px;font:inherit}button{border:0;border-radius:10px;padding:10px 15px;background:#e64350;color:white;cursor:pointer;font:inherit}ul{padding:0;list-style:none}li{display:flex;align-items:center;gap:12px;padding:15px 0;border-bottom:1px solid #f0f0f2}li span{flex:1;overflow-wrap:anywhere}li.done span{text-decoration:line-through;color:#a0a0aa}li button{background:#f5f5f7;color:#8d8d98;font-size:12px}input[type=checkbox]{accent-color:#e64350;width:17px;height:17px}.count{margin-top:24px;color:#92929c;font-size:12px}@media(max-width:700px){main{margin:20px;padding:23px}}\n' +
      '</style></head><body><main><div class="muted">本地模板演示 · 独立 TODO 应用</div><h1>' + escape(title) + '</h1><p class="muted">任务仅保存在当前浏览器。未调用 AI，不会上传到服务器。</p><form id="form"><input id="task" type="text" maxlength="180" placeholder="添加一个小目标…" aria-label="新任务" required><button type="submit">添加</button></form><ul id="list"></ul><div class="count" id="count" role="status"></div></main><script>\n' +
      "'use strict';\nconst storageKey='ensemble-demo-todos-v1';\nlet tasks=[];\ntry { const saved=JSON.parse(localStorage.getItem(storageKey)||'[]'); tasks=Array.isArray(saved)?saved.filter(t=>t&&typeof t.id==='string'&&typeof t.text==='string'&&typeof t.done==='boolean').slice(0,500):[]; } catch (_) {}\nconst list=document.getElementById('list');\nfunction save(){try{localStorage.setItem(storageKey,JSON.stringify(tasks));}catch(_){document.getElementById('count').textContent='浏览器存储不可用，刷新后任务将丢失。';}}\nfunction render(){list.replaceChildren();for(const task of tasks){const row=document.createElement('li');row.className=task.done?'done':'';const check=document.createElement('input');check.type='checkbox';check.checked=task.done;check.setAttribute('aria-label','完成 '+task.text);check.addEventListener('change',()=>{task.done=check.checked;render();save();});const label=document.createElement('span');label.textContent=task.text;const remove=document.createElement('button');remove.type='button';remove.textContent='删除';remove.setAttribute('aria-label','删除 '+task.text);remove.addEventListener('click',()=>{tasks=tasks.filter(item=>item.id!==task.id);render();save();});row.append(check,label,remove);list.append(row);}document.getElementById('count').textContent=tasks.length?`${tasks.filter(t=>t.done).length} / ${tasks.length} 项已完成`:'还没有任务，写下第一个小目标吧。';}\ndocument.getElementById('form').addEventListener('submit',event=>{event.preventDefault();const input=document.getElementById('task');const text=input.value.trim();if(!text||tasks.length>=500)return;tasks.push({id:typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random(),text,done:false});input.value='';render();save();input.focus();});\nrender();\n" +
      '</script></body></html>';
  }

  // Shared layout coordinates keep the browser preview and editable PPTX aligned.
  function lineWidth(text,size){return Array.from(clean(text)).reduce(function(sum,ch){return sum+(ch.charCodeAt(0)>255?1:/[MW@#]/.test(ch)?.82:/[il.,:! ]/.test(ch)?.3:.55)*size;},0);}
  function wrapText(text,width,size){
    var lines=[];
    clean(text).split('\n').forEach(function(paragraph){var line='';(paragraph.match(/[A-Za-z0-9_./-]+|\s+|./gu)||[]).forEach(function(token){var parts=lineWidth(token,size)>width*64?Array.from(token):[token];parts.forEach(function(ch){if(line&&lineWidth(line+ch,size)>width*64&&!/^[,.;:!?，。；：！？、）】》％%]/u.test(ch)){lines.push(line.trimEnd());line=ch.trimStart();}else line+=ch;});});lines.push(line.trimEnd());});
    return lines;
  }
  function fitted(text,w,h,size,min){while(size>min&&wrapText(text,w,size).length*size*1.15>h*72)size-=.5;return size;}
  function slidePlan(slide,index,total){
    var tone=slide.tone||((slide.type==='cover'||slide.type==='closing')?'ink':'paper');
    var colors=tone==='ink'?{bg:'202B36',fg:'F8FAF8',muted:'C6D3D7',accent:'B9DBC9'}:tone==='sage'?{bg:'DFEBE3',fg:'193D32',muted:'3F6055',accent:'24644B'}:{bg:'F8F7F2',fg:'24372F',muted:'53635B',accent:'387A60'};
    var boxes=[],items=slide.items||[],layout=slide.layout||(items.length===1?'focus':'editorial');
    function add(name,text,x,y,w,h,size,color,bold,min){if(!text)return;size=fitted(text,w,h,size,min||17);boxes.push({name:name,text:wrapText(text,w,size).join('\n'),x:x,y:y,w:w,h:h,size:size,color:color||colors.fg,bold:!!bold});}
    add('Section',slide.kicker,.8,.5,11.7,.35,12,colors.accent,true,11);
    if(slide.type==='cover'){
      add('Title',slide.title,.8,2,11.6,2.1,56,colors.fg,true,32);
      add('Subtitle',slide.subtitle,.84,4.35,10.8,1.1,24,colors.muted,false,19);
    }else{
      add('Title',slide.title,.8,1.05,11.65,1.1,34,colors.fg,true,24);
      add('Subtitle',slide.subtitle,.83,2.13,11.6,.55,18,colors.muted,false,17);
      if(layout==='focus'&&items.length===1){
        add('Main idea',items[0].title,.85,3.12,11.5,1.05,36,colors.fg,true,24);
        add('Explanation',items[0].body,.88,4.45,10.5,1.55,24,colors.muted,false,18);
      }else if(layout==='comparison'&&items.length===2){
        items.forEach(function(item,i){var x=.85+i*6;add('Item title '+(i+1),item.title,x,3.08,5.35,1.05,28,colors.fg,true,21);add('Item body '+(i+1),item.body,x,4.4,5.3,2.2,22,colors.muted,false,17);});
      }else if(layout==='process'&&items.length>=2){
        var width=11.65/items.length;
        items.forEach(function(item,i){var x=.85+i*width;add('Step '+(i+1),('0'+(i+1)).slice(-2),x,3.04,width-.3,.55,25,colors.accent,true);add('Item title '+(i+1),item.title,x,3.83,width-.4,1,23,colors.fg,true,17);add('Item body '+(i+1),item.body,x,5.02,width-.4,1.5,19,colors.muted,false,17);});
      }else if(items.length===4){
        items.forEach(function(item,i){var x=.85+(i%2)*6,y=2.96+Math.floor(i/2)*1.9;add('Item title '+(i+1),item.title,x,y,5.35,.58,23,colors.fg,true,17);add('Item body '+(i+1),item.body,x,y+.66,5.35,1.13,19,colors.muted,false,17);});
      }else{
        var gap=items.length===3?1.28:1.7;
        items.forEach(function(item,i){var y=3.02+i*gap;add('Item number '+(i+1),('0'+(i+1)).slice(-2),.85,y,.6,.4,15,colors.accent,true,14);add('Item title '+(i+1),item.title,1.6,y,10.7,.48,23,colors.fg,true,18);add('Item body '+(i+1),item.body,1.6,y+.52,10.6,gap-.6,19,colors.muted,false,17);});
      }
    }
    add('Footer',slide.footer,.83,7,10.5,.25,9,colors.muted,false,9);
    add('Page number',String(index+1)+' / '+total,11.65,7,.85,.25,9,colors.muted,false,9);
    return {background:colors.bg,boxes:boxes,layout:layout};
  }
  function slideHtml(slide,index,total){
    var plan=slidePlan(slide,index,total||5);
    return '<section class="artifact-slide" data-layout="'+escape(plan.layout)+'" style="container-type:inline-size;position:relative;width:100%;aspect-ratio:16/9;background:#'+plan.background+';overflow:hidden;font-family:Aptos,Microsoft YaHei,sans-serif">'+plan.boxes.map(function(b){return '<div data-slide-text="'+escape(b.name)+'" style="position:absolute;box-sizing:border-box;left:'+(b.x/13.333333*100)+'%;top:'+(b.y/7.5*100)+'%;width:'+(b.w/13.333333*100)+'%;height:'+(b.h/7.5*100)+'%;font-size:'+(b.size/9.6)+'cqw;line-height:1.15;color:#'+b.color+';font-weight:'+(b.bold?'700':'400')+';white-space:pre;overflow:visible">'+escape(b.text)+'</div>';}).join('')+'</section>';
  }

  // A minimal, editable, standards-based PowerPoint package. No CDN or library.
  var NS = 'http://schemas.openxmlformats.org/';
  var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var EMU = 914400;
  function inch(n) { return Math.round(n * EMU); }
  function fill(color) { return '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill>'; }
  function paragraph(value, size, color, bold) { return '<a:p><a:pPr marL="0" indent="0"><a:lnSpc><a:spcPct val="115000"/></a:lnSpc></a:pPr><a:r><a:rPr lang="zh-CN" sz="' + Math.round(size * 100) + '" b="' + (bold ? '1' : '0') + '">' + fill(color) + '<a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:rPr><a:t xml:space="preserve">' + escape(value) + '</a:t></a:r><a:endParaRPr lang="zh-CN" sz="' + Math.round(size * 100) + '"/></a:p>'; }
  function textBox(id, name, text, x, y, w, h, size, color, bold) {
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + escape(name) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + inch(x) + '" y="' + inch(y) + '"/><a:ext cx="' + inch(w) + '" cy="' + inch(h) + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"/><a:lstStyle/>' + clean(text).split('\n').map(function (p) { return paragraph(p, size, color, bold); }).join('') + '</p:txBody></p:sp>';
  }
  var GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  function slideXml(slide,index,count,artifact){
    var plan=slidePlan(slide,index,count),shapes=plan.boxes.map(function(b,i){return textBox(i+2,b.name,b.text,b.x,b.y,b.w,b.h,b.size,b.color,b.bold);});
    return XML+'<p:sld xmlns:a="'+NS+'drawingml/2006/main" xmlns:r="'+NS+'officeDocument/2006/relationships" xmlns:p="'+NS+'presentationml/2006/main"><p:cSld name="'+escape(slide.title)+'"><p:bg><p:bgPr>'+fill(plan.background)+'<a:effectLst/></p:bgPr></p:bg><p:spTree>'+GROUP+shapes.join('')+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }
  function relationships(items) { return XML + '<Relationships xmlns="' + NS + 'package/2006/relationships">' + items.map(function (item) { return '<Relationship Id="' + item[0] + '" Type="' + NS + (item[1] === 'core-properties' ? 'package/2006/metadata/core-properties' : 'officeDocument/2006/relationships/' + item[1]) + '" Target="' + item[2] + '"/>'; }).join('') + '</Relationships>'; }

  function toPptx(artifact) {
    if (!artifact || artifact.kind !== 'ppt' || !Array.isArray(artifact.slides) || !artifact.slides.length) throw new Error('需要包含幻灯片的 PPT 产物');
    var slides = artifact.slides, files = {}, overrides = [
      ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
      ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
      ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
      ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
      ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
      ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']
    ];
    slides.forEach(function (s, i) { overrides.push(['/ppt/slides/slide' + (i + 1) + '.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']); });
    files['[Content_Types].xml'] = XML + '<Types xmlns="' + NS + 'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + overrides.map(function (v) { return '<Override PartName="' + v[0] + '" ContentType="' + v[1] + '"/>'; }).join('') + '</Types>';
    files['_rels/.rels'] = relationships([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]);
    files['docProps/core.xml'] = XML + '<cp:coreProperties xmlns:cp="' + NS + 'package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + escape(artifact.title) + '</dc:title><dc:creator>Resonance Gongming</dc:creator><dc:description>' + escape(artifact.summary || artifact.notice || 'Resonance 可编辑演示文稿') + '</dc:description></cp:coreProperties>';
    files['docProps/app.xml'] = XML + '<Properties xmlns="' + NS + 'officeDocument/2006/extended-properties" xmlns:vt="' + NS + 'officeDocument/2006/docPropsVTypes"><Application>Gongming Studio</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>' + slides.length + '</Slides></Properties>';
    files['ppt/presentation.xml'] = XML + '<p:presentation xmlns:a="' + NS + 'drawingml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships" xmlns:p="' + NS + 'presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>' + slides.map(function (s, i) { return '<p:sldId id="' + (256 + i) + '" r:id="rIdSlide' + (i + 1) + '"/>'; }).join('') + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle></p:presentation>';
    files['ppt/_rels/presentation.xml.rels'] = relationships([['rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml']].concat(slides.map(function (s, i) { return ['rIdSlide' + (i + 1), 'slide', 'slides/slide' + (i + 1) + '.xml']; })));
    files['ppt/slideMasters/slideMaster1.xml'] = XML + '<p:sldMaster xmlns:a="' + NS + 'drawingml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships" xmlns:p="' + NS + 'presentationml/2006/main"><p:cSld name="Blank master"><p:spTree>' + GROUP + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>';
    files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = relationships([['rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rIdTheme', 'theme', '../theme/theme1.xml']]);
    files['ppt/slideLayouts/slideLayout1.xml'] = XML + '<p:sldLayout xmlns:a="' + NS + 'drawingml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships" xmlns:p="' + NS + 'presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>' + GROUP + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
    files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = relationships([['rIdMaster', 'slideMaster', '../slideMasters/slideMaster1.xml']]);
    files['ppt/theme/theme1.xml'] = themeXml();
    slides.forEach(function (slide, i) { var n = i + 1; files['ppt/slides/slide' + n + '.xml'] = slideXml(slide, i, slides.length, artifact); files['ppt/slides/_rels/slide' + n + '.xml.rels'] = relationships([['rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml']]); });
    return zipStore(files);
  }

  function themeXml() {
    var colors = { dk1: '202328', lt1: 'FFFFFF', dk2: '737A84', lt2: 'FBFAF8', accent1: 'E76B70', accent2: 'A8B593', accent3: 'E9C884', accent4: '91ABB4', accent5: 'ACA0BB', accent6: 'C7C7C3', hlink: 'E76B70', folHlink: 'ACA0BB' };
    var ph = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>', line = '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">' + ph + '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>';
    return XML + '<a:theme xmlns:a="' + NS + 'drawingml/2006/main" name="Ensemble"><a:themeElements><a:clrScheme name="Ensemble">' + Object.keys(colors).map(function (key) { return '<a:' + key + '><a:srgbClr val="' + colors[key] + '"/></a:' + key + '>'; }).join('') + '</a:clrScheme><a:fontScheme name="Ensemble"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Ensemble"><a:fillStyleLst>' + ph + ph + ph + '</a:fillStyleLst><a:lnStyleLst>' + line + line + line + '</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>' + ph + ph + ph + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
  }

  var crcTable = (function () { var table = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1; table[n] = c; } return table; })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ c >>> 8; return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {
    var chunks = [], central = [], offset = 0, centralSize = 0, names = Object.keys(files);
    names.forEach(function (name) {
      var nb = encoder.encode(name), data = encoder.encode(files[name]), crc = crc32(data), local = new Uint8Array(30 + nb.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(12, 33, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); local.set(nb, 30);
      var cd = new Uint8Array(46 + nb.length), cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014B50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(14, 33, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true); cd.set(nb, 46);
      chunks.push(local, data); central.push(cd); offset += local.length + data.length; centralSize += cd.length;
    });
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true); ev.setUint16(8, names.length, true); ev.setUint16(10, names.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    var output = new Uint8Array(offset + centralSize + end.length), cursor = 0;
    chunks.concat(central, [end]).forEach(function (chunk) { output.set(chunk, cursor); cursor += chunk.length; });
    return output;
  }

  async function download(artifact) {
    if (!artifact) throw new Error('没有可下载的产物');
    var ext, type, content;
    if (artifact.kind === 'ppt') { ext = '.pptx'; type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; content = toPptx(artifact); }
    else if (artifact.kind === 'website') { ext = '.html'; type = 'text/html;charset=utf-8'; content = artifact.html; }
    else if (artifact.kind === 'code') { ext = '.txt'; type = 'text/plain;charset=utf-8'; content = artifact.code; }
    else if (artifact.kind === 'document' || artifact.kind === 'project') { ext = '.md'; type = 'text/markdown;charset=utf-8'; content = artifact.markdown; }
    else throw new Error('不支持的产物类型');
    var blob = new Blob([content], { type: type }), name = filename(artifact.title) + ext;
    if (typeof document !== 'undefined') { var url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 30000); }
    return { filename: name, blob: blob };
  }
  return { create: create, download: download, toPptx: toPptx, slideHtml: slideHtml, escape: escape, notice: NOTICE };
});
