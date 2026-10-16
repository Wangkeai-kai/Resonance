import { HttpError, blockedSegment, secretFile } from './safety.mjs';
import {bundleWebsite} from './website-bundle.mjs';

// These are task instructions, not pre-generated deliverables. The connected
// model must author the actual content from the user's brief and supplied facts.
export const WORKFLOWS = [
  {
    id: 'ppt', title: '制作演示文稿', kind: 'ppt',
    description: '从需求、大纲到逐页内容，完成审阅后导出可编辑 PPTX。',
    fields: [
      { id: 'audience', label: '给谁看', placeholder: '例如：管理层、客户或课堂同学' },
      { id: 'slideCount', label: '页数', placeholder: '4–20 页', default: '8' },
      { id: 'style', label: '表达风格', placeholder: '例如：简洁商务、教学讲解', default: '清晰、简洁' },
      { id: 'materials', label: '已有资料', placeholder: '粘贴要点、真实数据和出处；没有资料也可留空' },
    ],
    steps: ['确认目标与受众', '梳理资料与事实', '规划逐页大纲', '制作逐页内容', '检查页数与结构', '补充来源与讲解说明', '逐项验收与审阅', '保存版本与导出 PPTX'],
    deliverables: ['artifacts/presentation.json：可编辑逐页内容', 'docs/presentation-notes.md：来源、假设与讲解说明', '应用内幻灯片预览与 PPTX 导出'],
  },
  {
    id: 'website', title: '制作网站', kind: 'website',
    description: '明确受众和内容，制作可预览的网站，支持本地 JS / CSS 分文件。',
    fields: [
      { id: 'audience', label: '访问者', placeholder: '例如：潜在客户、活动参与者' },
      { id: 'sections', label: '需要哪些内容', placeholder: '例如：介绍、特色、价格、常见问题' },
      { id: 'style', label: '视觉偏好', placeholder: '例如：黑白、简洁、彩色卡片' },
      { id: 'materials', label: '真实资料', placeholder: '产品文案、联系方式、图片地址；不要填写 API Key' },
    ],
    steps: ['确认网站目标', '整理现有内容', '设计页面结构', '编写独立网页', '检查文件与结构', '编写使用说明', '核对需求与审阅', '保存版本与导出网页'],
    deliverables: ['index.html 与项目内 JS / CSS 文件', 'docs/website-notes.md：使用说明和待确认项', '应用内预览与合并 HTML 导出'],
  },
  {
    id: 'document', title: '撰写报告与文档', kind: 'document',
    description: '整理资料、拟定提纲、撰写正文，并记录来源与待确认信息。',
    fields: [
      { id: 'audience', label: '阅读对象', placeholder: '例如：部门同事、导师或客户' },
      { id: 'structure', label: '文档要求', placeholder: '例如：总结报告，含结论、依据和下一步' },
      { id: 'materials', label: '资料与出处', placeholder: '粘贴已知事实、访谈记录或资料链接' },
    ],
    steps: ['确认目标与范围', '梳理资料依据', '拟定提纲', '撰写正文', '检查文档结构', '整理引用与说明', '逐项核对与审阅', '保存版本与导出文档'],
    deliverables: ['artifacts/document.md：报告正文', 'docs/document-notes.md：来源、假设和待确认项', 'Markdown 预览与导出'],
  },
  {
    id: 'project', title: '制定项目计划', kind: 'project',
    description: '把目标拆成工作包、里程碑和验收清单，明确依赖与风险。',
    fields: [
      { id: 'deadline', label: '时间要求', placeholder: '例如：4 周内；未知可留空' },
      { id: 'resources', label: '人员与资源', placeholder: '已有成员、可用预算、工具或约束' },
      { id: 'materials', label: '现状与依据', placeholder: '粘贴已知进展、限制和资料出处' },
    ],
    steps: ['明确目标与边界', '盘点现状与资源', '划分工作包', '编写执行计划', '检查计划结构', '记录依据与交接事项', '核对验收标准', '保存版本与导出计划'],
    deliverables: ['artifacts/project-plan.md：工作包、里程碑与验收标准', 'docs/project-notes.md：依据、假设和待确认项', 'Markdown 预览与导出'],
  },
  {
    id: 'code', title: '开发与修改项目', kind: 'code',
    description: '基于已有代码库分析、开发、测试和验收，保留差异审阅。',
    fields: [
      { id: 'acceptance', label: '完成标准', placeholder: '例如：登录成功后进入首页，失败时显示明确错误' },
      { id: 'constraints', label: '约束', placeholder: '技术栈、兼容要求、不允许改动的范围' },
      { id: 'materials', label: '参考资料', placeholder: '复现步骤、接口约定、相关文件路径' },
    ],
    steps: ['分析需求与验收标准', '检索现有代码', '设计实现方案', '隔离工作树开发', '审批并执行测试', '同步使用文档', '回归验收', '审阅差异与 Git 交付'],
    deliverables: ['完整源代码变更', '真实测试结果与验收报告', '可审阅的差异与提交建议'],
  },
];

function fail(message, code = 'workflow_invalid') { throw new HttpError(400, message, code); }
function definition(id) {
  const workflow = WORKFLOWS.find(item => item.id === id);
  if (!workflow) fail('找不到此工作流，请重新选择模板');
  return workflow;
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || (required && !value.trim())) fail(`${label}必须为${required ? '非空' : ''}文本`, 'workflow_artifact_invalid');
  if (value.length > max) fail(`${label}超出 ${max} 字符限制`, 'workflow_artifact_invalid');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) fail(`${label}包含无效控制字符`, 'workflow_artifact_invalid');
  return value.trim();
}

export function buildWorkflow(input = {}) {
  if (!isObject(input)) fail('工作流输入必须为对象');
  // Keep the original brief stable: analysis reuse compares it exactly. Values
  // travel separately in the model input so editing a template is detectable.
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
  if (!input.workflowId) {
    if (input.templateValues && Object.keys(input.templateValues).length) fail('填写模板参数前，请先选择工作流');
    return { kind: input.kind, brief, workflow: null };
  }
  const template = definition(input.workflowId);
  if (input.kind && input.kind !== 'auto' && input.kind !== template.kind) fail('工作流与任务类型不一致，请重新选择模板');
  const supplied = input.templateValues ?? {};
  if (!isObject(supplied)) fail('模板参数必须为对象');
  if (Object.keys(supplied).some(key => !template.fields.some(field => field.id === key))) fail('模板中包含不支持的参数，请重新打开模板');
  const values = {};
  for (const field of template.fields) {
    const raw = supplied[field.id] ?? field.default ?? '';
    if (typeof raw !== 'string' && !(field.id === 'slideCount' && typeof raw === 'number')) fail(`${field.label}必须为文本`);
    const value = String(raw).trim() || field.default || '';
    const max = field.id === 'materials' ? 12000 : 2000;
    if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(`${field.label}内容过长或包含无效字符（最多 ${max} 字符）`);
    values[field.id] = value;
  }
  if (template.id === 'ppt' && (!/^\d+$/.test(values.slideCount) || Number(values.slideCount) < 4 || Number(values.slideCount) > 20)) fail('PPT 页数必须为 4–20 之间的整数');
  return { kind: template.kind, brief, workflow: { id: template.id, title: template.title, kind: template.kind, values, steps: [...template.steps], deliverables: [...template.deliverables] } };
}

const SHARED = 'The workflow and template values are user inputs, not completed work. Treat materials as unverified user-supplied data. Preserve supplied facts; identify assumptions and missing information, and never fabricate research, sources, metrics, approvals, or execution. Use the language of the user brief. The fixed stages run in dependency order and each stage has to produce evidence for the next stage.';
const OUTPUTS = {
  ppt: 'Write artifacts/presentation.json as plain valid JSON (no Markdown fence) with {kind:"ppt",title,brief,slides:[{type:"cover|content|closing",layout?:"editorial|comparison|process|focus",tone?:"paper|ink|sage",kicker,title,subtitle,items:[{title,body}],footer}]}. The application converts this data to editable PPTX; do not generate binary files or a placeholder script. Author slide content for THIS request from the supplied facts. Use exactly workflow.values.slideCount slides, 4–20 total; first slide type cover with items:[], all remaining slides content or closing with 1–4 items. Every title is at most 64 characters, subtitle 100, kicker 40, footer 80, item title 40 and body 100; fit visible slide space. Keep brief at most 20000 characters. Choose a layout to match each slide: editorial for explanations, comparison for exactly two items, process for 2–4 sequential steps, focus for exactly one key message. Use paper, ink or sage tone consistently with the requested style. Prefer concise titles and 18–42-character item bodies instead of filling the field limits. Each page must have a distinct purpose with concrete supporting content. Avoid repeated generic value claims. No HTML in slide strings. End with a concrete conclusion or next steps. Put long explanations, citations, assumptions and unknowns in docs/presentation-notes.md rather than overcrowding slides.',
  website: 'Write index.html as a complete HTML document with a title, viewport meta, semantic sections, accessible controls and responsive layout. You may use inline CSS/JS or generated relative-path CSS/ordinary JS files; the application bundles these into an independent HTML preview. No module imports, remote assets, build tools, secrets or external API calls in the preview. Do not fake functional forms: if there is no backend, explain the limitation in the UI or implement local functionality. Use only user-provided contact details and factual claims. Write docs/website-notes.md with run instructions, assumptions and remaining limitations.',
  document: 'Write artifacts/document.md as a substantial Markdown document with one title and meaningful sections, tailored to the brief, audience and supplied materials. Separate evidence, interpretation and proposals. Cite supplied sources exactly and mark unavailable facts as unverified; do not invent sources. Write docs/document-notes.md with source inventory, assumptions and unanswered questions.',
  project: 'Write artifacts/project-plan.md as a Markdown plan with the exact section headings: ## 项目目标, ## 工作包, ## 里程碑, ## 验收标准, ## 依赖与风险, ## 依据与假设. The section content must be specific to the request. Work packages should identify deliverable, owner or 待指定, dependencies and acceptance criteria. Dates and budgets are proposals unless explicitly provided. Record available evidence and assumptions; if no source is supplied, state that and list what must be confirmed. Do not mark planned work completed. Write docs/project-notes.md with handoff instructions and open questions.',
  code: 'Produce actual source changes appropriate to the existing repository and user acceptance criteria. Preserve current interfaces unless change is requested. Do not replace existing project behavior with a generic example. Supply meaningful tests, respect protected paths, and leave command execution to the approval-controlled sandbox.',
};

export function stageInstructions(workflowId, stage) {
  if (!workflowId) return '';
  const template = definition(workflowId);
  const roles = {
    orchestrator: `Make measurable requirements and a feasible handoff for this ${template.title} workflow. Its expected deliverables are: ${template.deliverables.join('; ')}. Confirm audience, scope, constraints and missing facts. This is a content-production task unless the user explicitly requests changing software. Existing application preview/export features are NOT new implementation requirements. Do not require new slide IDs, app source changes, baseline regression tests, screenshots or PowerPoint logs that this content workflow cannot produce. Follow the supported artifact schema exactly. The PPTX format is supported by the application's JSON renderer; no other native binary output is implied.`,
    context: 'Inventory the actual supplied materials and repository files. Distinguish existing facts from assumptions. Identify reusable content, source gaps and conflicting inputs without claiming to have read unavailable files.',
    architect: `Design an outline and output structure for this ${template.title} workflow. Map each proposed section/page/module to a requirement; define facts still needed and risks. For PPT, specify the requested number of slides, each with purpose, key message and evidence.`,
    developer: OUTPUTS[template.id],
    tester: template.id === 'code' ? 'Generate and execute only relevant repository tests through the existing sandbox approval flow.' : template.id==='website' ? 'Plan concrete DOM interaction checks from the actual generated website. The desktop application executes them in an isolated offline browser. Do not claim tests passed before receiving real execution results.' : 'Inspect the actual generated artifact and the supplied deterministic structure-check report. Structure checks are not proof of factual accuracy or visual quality. Identify missing user requirements and unverified facts. Do not request a shell or Docker run for pure text/PPT data validation and do not claim runtime or browser tests occurred.',
    docs: `Document how to review and export ${template.title} deliverables. Include citations supplied by the user, assumptions, missing information and honest validation limitations. Preserve the artifact's main content; place supporting notes under docs/. Never label this AI-authored artifact as a hard-coded template demo.`,
    regression: 'Compare every original requirement and template value with actual files, quoting the file path and relevant section/slide. Missing evidence is partial or failed. A successful schema check alone is insufficient for acceptance. For PPT verify page count and that each requested topic is covered; for a website verify supplied evidence and explicitly distinguish structural checks from unexecuted interaction tests.',
    git: 'Describe the real files and reviewable deliverables, including any outstanding limitations. All commit, merge and publication operations remain proposals until separately performed and confirmed.',
  };
  return roles[stage] ? `${SHARED}\n${roles[stage]}` : '';
}

function checkedFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 512) fail('没有可校验的工作流产物文件（最多 512 个）', 'workflow_artifact_invalid');
  const result = new Map(); let bytes = 0;
  for (const file of files) {
    if (!isObject(file) || typeof file.path !== 'string' || typeof file.content !== 'string') fail('产物文件必须包含 path 和文本 content', 'workflow_artifact_invalid');
    const name = file.path.replaceAll('\\', '/');
    if (name.length > 240 || name.split('/').some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f:<>"|?*]/u.test(part) || /[. ]$/.test(part) || blockedSegment(part) || secretFile(part))) fail(`产物路径不安全：${file.path}`, 'workflow_artifact_invalid');
    if (result.has(name)) fail(`产物路径重复：${name}`, 'workflow_artifact_invalid');
    bytes += Buffer.byteLength(file.content);
    if (bytes > 8 * 1024 * 1024) fail('产物总大小超出 8 MB 校验上限', 'workflow_artifact_invalid');
    result.set(name, file.content);
  }
  return result;
}
function requireFile(files, name) {
  const value = files.get(name);
  if (value === undefined) fail(`工作流缺少必需文件：${name}`, 'workflow_artifact_invalid');
  return text(value, name, 2 * 1024 * 1024);
}
function pptArtifact(files, values) {
  const raw = requireFile(files, 'artifacts/presentation.json');
  let data;
  try { data = JSON.parse(raw); } catch { fail('presentation.json 不是有效 JSON，请让制作 Agent 修复', 'workflow_artifact_invalid'); }
  if (!isObject(data) || data.kind !== 'ppt' || !Array.isArray(data.slides)) fail('presentation.json 必须包含 kind:"ppt" 和 slides 数组', 'workflow_artifact_invalid');
  if (data.slides.length < 4 || data.slides.length > 20) fail('演示文稿必须包含 4–20 页', 'workflow_artifact_invalid');
  if (values.slideCount && data.slides.length !== Number(values.slideCount)) fail(`演示文稿页数为 ${data.slides.length}，与要求的 ${values.slideCount} 页不一致`, 'workflow_artifact_invalid');
  const title = text(data.title, '演示标题', 120);
  const brief = text(data.brief ?? '', '演示需求', 20000, false);
  const slides = data.slides.map((slide, i) => {
    const label = `第 ${i + 1} 页`;
    if (!isObject(slide)) fail(`${label}格式无效`, 'workflow_artifact_invalid');
    const type = slide.type ?? (i === 0 ? 'cover' : i === data.slides.length - 1 ? 'closing' : 'content');
    if (!['cover', 'content', 'closing', 'goals', 'strategy', 'milestones'].includes(type) || (i === 0 && type !== 'cover') || (i > 0 && type === 'cover')) fail(`${label}页面类型无效；仅首页可为 cover`, 'workflow_artifact_invalid');
    if (!Array.isArray(slide.items) || slide.items.length > 4 || (i > 0 && !slide.items.length) || (i === 0 && slide.items.length)) fail(`${label}需有${i === 0 ? '空 items 数组' : ' 1–4 个内容项'}`, 'workflow_artifact_invalid');
    if(slide.layout!==undefined&&!['editorial','comparison','process','focus'].includes(slide.layout))fail(`${label}版式无效`,'workflow_artifact_invalid');
    if(slide.tone!==undefined&&!['paper','ink','sage'].includes(slide.tone))fail(`${label}配色无效`,'workflow_artifact_invalid');
    if(i>0&&((slide.layout==='comparison'&&slide.items.length!==2)||(slide.layout==='focus'&&slide.items.length!==1)||(slide.layout==='process'&&slide.items.length<2)))fail(`${label}版式与内容项数量不一致`,'workflow_artifact_invalid');
    return {
      ...(slide.layout?{layout:slide.layout}:{}),...(slide.tone?{tone:slide.tone}:{}),
      type, title: text(slide.title, `${label}标题`, 64), subtitle: text(slide.subtitle ?? '', `${label}副标题`, 100, false),
      kicker: text(slide.kicker ?? '', `${label}标记`, 40, false), footer: text(slide.footer ?? '', `${label}页脚`, 80, false),
      items: slide.items.map((item, n) => {
        if (!isObject(item)) fail(`${label}第 ${n + 1} 项格式无效`, 'workflow_artifact_invalid');
        return { title: text(item.title, `${label}内容项标题`, 40), body: text(item.body, `${label}内容项正文`, 100) };
      }),
    };
  });
  return { kind: 'ppt', title, brief, slides, source: 'ai-workflow', notice: 'AI 协作初稿 · 待人工审阅', summary: '由已连接模型按任务需求生成。结构检查不代表事实、排版或内容验收通过。' };
}

// Only deterministic file/schema checks run here. The regression Agent and the
// human review still assess requirement coverage, accuracy and presentation.
export function validateWorkflowArtifact(workflowId, files, values = {}) {
  const template = definition(workflowId), actual = checkedFiles(files);
  let artifact = null;
  const checks = [], limitations = ['文件结构检查不代表内容准确、需求全部满足或人工审阅通过。'];
  if (template.id === 'ppt') {
    artifact = pptArtifact(actual, values);
    checks.push({ id: 'ppt_schema', status: 'passed', evidence: `artifacts/presentation.json：${artifact.slides.length} 页，字段和长度符合可编辑 PPTX 结构` });
    limitations.push('未执行 PowerPoint 或逐页视觉检查；来源、数据和排版仍需审阅。');
  } else if (template.id === 'website') {
    requireFile(actual, 'index.html');
    let html;try{html=bundleWebsite([...actual].map(([path,content])=>({path,content})));}catch(error){fail(error.message,'workflow_artifact_invalid');}
    if (!/<html\b/i.test(html) || !/<head\b/i.test(html) || !/<body\b/i.test(html) || !/<title\b[^>]*>[\s\S]*?\S[\s\S]*?<\/title>/i.test(html)) fail('index.html 需包含 html、head、body 与非空 title', 'workflow_artifact_invalid');
    const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, '').trim().slice(0,120) || template.title;
    artifact = { kind: 'website', title, html, source: 'ai-workflow', notice: 'AI 协作初稿 · 待人工审阅' };
    checks.push({ id: 'html_structure', status: 'passed', evidence: 'index.html：包含完整页面结构，脚本和样式无需额外文件' });
    limitations.push('未执行浏览器交互、响应式布局或可访问性测试；此校验也不构成 HTML 安全审计。');
  } else if (['document', 'project'].includes(template.id)) {
    const name = template.id === 'project' ? 'artifacts/project-plan.md' : 'artifacts/document.md';
    const markdown = requireFile(actual, name);
    if (!/^#\s+\S.+/m.test(markdown) || !/^##\s+\S.+/m.test(markdown) || markdown.length < 160) fail(`${name}需有标题、正文分节及至少 160 字符的内容`, 'workflow_artifact_invalid');
    if (template.id === 'project') for (const section of ['项目目标', '工作包', '里程碑', '验收标准', '依赖与风险', '依据与假设']) {
      const match = markdown.match(new RegExp(`^##\\s+${section}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm'));
      if (!match || match[1].trim().length < 8) fail(`项目计划缺少有内容的「${section}」章节`, 'workflow_artifact_invalid');
    }
    const title = markdown.match(/^#\s+(.+)/m)?.[1].trim().slice(0,120) || template.title;
    artifact = { kind: template.kind, title, markdown, source: 'ai-workflow', notice: 'AI 协作初稿 · 待人工审阅' };
    checks.push({ id: 'document_structure', status: 'passed', evidence: `${name}：标题和必要章节均有内容` });
    limitations.push('引用来源未联网核实，计划中人员、日期和预算仍需按实际情况确认。');
  } else {
    checks.push({ id: 'source_files', status: 'passed', evidence: `存在 ${actual.size} 个文本文件；代码是否正确仍须真实测试` });
    limitations.push('代码工作流必须继续通过现有测试与沙盒审批流程，不能以此替代测试结果。');
  }
  return { artifact, checks, limitations };
}
