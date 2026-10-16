/* Plain-language descriptions of the existing approval actions; no permissions are granted here. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const basename = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const short = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return String(text ?? '').slice(0, 160) + (String(text ?? '').length > 160 ? '…' : ''); };
  function describe(item = {}) {
    const d = item.details || {};
    const where = basename(d.worktree || d.projectPath || d.cwd);
    const site = (() => { try { return new URL(item.url).host; } catch { return '已连接的服务'; } })();
    const common = { label:'待确认操作', title:item.title || '确认这次操作', purpose:'操作需要你的明确确认才能继续。', effect:'请展开操作详情，核对涉及的数据、文件和执行范围。', outcome:'系统将尝试执行详情中列出的操作，结果会记录在此任务中。', decline:'不会执行这次操作。后续任务能否继续取决于它的依赖步骤。', approve:'同意这次操作', reject:'拒绝这次操作' };
    switch (item.type) {
      case 'sandbox': return {...common, label:'检查作品', title:'运行一次隔离测试', purpose:'检查生成的代码能否通过自动化测试，供后续验收参考。', effect:`读取本任务的文件${where ? `（${where}）` : ''}，在本机隔离容器里运行测试。容器不能联网，也不能改写任务文件；运行时间与资源有限。`, outcome:'已有 Docker 环境和测试镜像可用时开始测试。通过后继续任务；失败时可能安排修复，修复后的测试会产生新的审批请求。', decline:'这次测试不会运行，当前任务会停止并标为失败。处理后可从任务记录重试。', approve:'同意运行测试', reject:'拒绝并停止测试', note:d.dockerAvailable === false ? '目前未检测到可用的 Docker。点击同意后会再次检查；仍不可用时不会执行测试。' : ''};
      case 'commit': return {...common, label:'保存版本', title:'为这次任务保存一个版本', purpose:'把本任务列出的文件保存为一个可追溯的 Git 版本，方便之后合并或回看。', effect:`在本任务独立工作区${where ? `（${where}）` : ''}保存${Array.isArray(d.files) ? ` ${d.files.length} 个文件` : '列出的文件'}${d.branch ? `，分支为 ${d.branch}` : ''}。原项目分支不变，不会上传 GitHub。`, outcome:'成功后会得到一个版本编号。把这些修改合入原项目需要另一次确认。', decline:'文件会保留在任务工作区，这次不创建版本。之后仍可重新申请保存。', approve:'同意保存版本', reject:'暂不保存版本'};
      case 'merge': return {...common, label:'更新原项目', title:'把任务成果合入原项目', purpose:'让已保存的任务成果进入原项目，供你继续使用和开发。', effect:`会修改原项目${where ? `「${where}」` : ''}的文件和${d.targetBranch ? ` ${d.targetBranch} ` : '当前'}分支。来源${d.sourceBranch ? `为 ${d.sourceBranch}` : '是这次任务保存的版本'}。这次操作不会上传 GitHub。`, outcome:'项目没有未保存的 Git 修改、分支与版本未变化时才会合并。出现冲突会尝试中止合并，并留给你处理。', decline:'原项目不会合入这次成果，任务中已保存的版本仍会保留。', approve:'同意更新原项目', reject:'保持原项目不变'};
      case 'rollback': return {...common, label:'撤销任务修改', title:'撤销这个任务已保存的修改', purpose:'用一个新的撤销版本抵消本任务的修改，保留原来的历史记录。', effect:`会修改${d.mainline ? '原项目' : '任务工作区'}${where ? `「${where}」` : ''}里的文件。只撤销本任务拥有的指定提交，不是恢复整个项目到某个日期。`, outcome:'工作区没有未保存的 Git 修改且版本未变化时才会执行。成功后生成撤销版本；出现冲突会尝试中止，并提示你处理。', decline:'保留当前文件和历史，这次不撤销修改。', approve:'同意撤销这次修改', reject:'保留当前修改'};
      case 'mcp': return {...common, label:'调用外部工具', title:`调用工具：${item.tool || '待确认工具'}`, purpose:`把下面列出的参数发送给「${item.serverName || 'MCP 服务'}」，执行 ${item.tool || '所选工具'}。`, effect:`接收服务：${site}。工具可能读取或修改该服务有权限访问的数据。实际影响由服务和参数决定，Resonance无法保证操作只读或可以撤销。`, outcome:'只发送这一次已确认的调用，并显示服务返回结果。若连接中断导致结果未知，先核对服务端状态，不会自动重试。', decline:'取消这次调用，不发送执行请求。需要时可以重新准备调用。', approve:'同意调用此工具', reject:'取消这次调用'};
      default: return common;
    }
  }
  function body(item = {}) {
    const info = describe(item), d = item.details || {};
    const isTool = item.type === 'mcp';
    const entries = isTool && item.arguments && typeof item.arguments === 'object' ? Object.entries(item.arguments) : [];
    const technical = isTool ? {service:item.serverName, url:item.url, tool:item.tool, arguments:item.arguments} : d;
    const commands = Array.isArray(d.commands) ? d.commands : [];
    return `<section class="approval-explainer" aria-label="操作说明"><div class="approval-kind">${esc(info.label)} · 仅确认本次操作</div><dl class="approval-facts"><div><dt>准备做什么</dt><dd>${esc(info.purpose)}</dd></div><div><dt>影响哪里</dt><dd>${esc(info.effect)}</dd></div>${isTool ? `<div><dt>会发送什么</dt><dd>${entries.length ? `<ul class="approval-arguments">${entries.slice(0, 5).map(([key,value]) => `<li><b>${esc(key)}</b><span>${esc(short(value))}</span></li>`).join('')}</ul>${entries.length > 5 ? `<span>另有 ${entries.length - 5} 项参数，可展开下方详情查看。</span>` : ''}` : '没有附加参数；仍会调用指定工具。'}</dd></div>` : ''}<div><dt>同意后</dt><dd>${esc(info.outcome)}</dd></div><div><dt>不同意时</dt><dd>${esc(info.decline)}</dd></div></dl>${info.note ? `<p class="approval-note">${esc(info.note)}</p>` : ''}<details class="approval-technical" data-detail-id="approval-scope-${esc(item.id || '')}"><summary>${isTool ? '查看服务地址与完整参数' : '查看具体文件、路径与命令'}</summary>${item.title ? `<p>原始请求：${esc(item.title)}</p>` : ''}${commands.length ? `<h4>将执行的命令</h4><pre>${esc(commands.map(command => [command.command, ...(command.args || [])].map(part => JSON.stringify(part)).join(' ')).join('\n'))}</pre>` : ''}<h4>完整操作记录</h4><pre>${esc(JSON.stringify(technical, null, 2))}</pre></details></section>`;
  }
  window.ApprovalUI = { describe, body };
})();
