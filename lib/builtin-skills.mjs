// Original, app-owned reference instructions. They never grant tool permissions.
export const BUILTIN_SKILLS = [
  {
    id: 'builtin-presentation', name: 'PPT 内容与版式', icon: '🎞️', kinds: ['ppt'],
    summary: '先讲清内容，再选择版式。每页一个重点，减少长段落，保留真实依据。',
    content: `用途：演示文稿的大纲、逐页内容和审阅。
先确定受众、汇报目的与听完后的行动。用户已有明确要求时直接完成，未知事实标记待确认，不编造数字、用户或出处。
先规划每页的作用和证据，避免把目录、价值、优势反复讲一遍。标题直接点明主题或有依据的结论，正文提供具体解释，删掉口号与套话。
每页围绕一个重点，正文通常 2–3 项。每项标题尽量 4–16 字，正文尽量 18–42 字，长解释进入讲解备注。不要为了凑满页数加入空泛内容。
按内容选择 layout：editorial 适合分项解释，comparison 只用于两项对照，process 适合 2–4 步流程，focus 用于一个核心观点。交替使用合适版式，避免每页都是相同列表。封面只保留名称与一句用途介绍。
遵守工作流 JSON 字段和字数限制。交付前逐页检查：标题和内容是否对应、是否重复、是否缺少用户要求、来源是否可信。结构通过不等于视觉或事实通过。`,
  },
  {
    id: 'builtin-web-design', name: '网站设计与交互', icon: '🌐', kinds: ['website'],
    summary: '明确页面重点，统一字体、间距与颜色，处理窄屏、空状态和真实交互。',
    content: `用途：网站与前端界面。先说明主要用户和最重要的操作，围绕实际内容设计信息层级。
统一字号、间距、色彩和控件样式。正文保持清晰对比度和适当行距，窄屏不横向溢出。不要堆叠无用卡片、装饰标签与虚假指标。
每个按钮都应有真实作用。表单具有标签、校验、加载、成功与失败状态；没有后端就明确本地功能范围。支持键盘操作、可见焦点、语义 HTML 与减弱动画。
使用用户的品牌与材料，不编造客户、评价或联系方式。优先复用已有项目规范。检查主要操作和移动布局，记录实际执行的检查与仍未验证的部分。`,
  },
  {
    id: 'builtin-report', name: '报告与资料整理', icon: '📝', kinds: ['document'],
    summary: '结论有依据，区分事实、分析与建议，整理引用和待确认信息。',
    content: `用途：报告、总结、调研和日常文档。先明确读者要回答的问题，再组织结论、依据与下一步。
保留材料中的单位、时间范围和限定条件。区分原始事实、推断、方案与未知项。只引用实际收到或已经读取的材料，URL 不等于已经读过网页。
每段表达一个要点，使用具体对象、动作与交付物。避免空泛背景、重复总结和无依据的形容词。数据适合对比时用简洁表格，不用虚构数字补齐表格。
检查逻辑、前后矛盾、引用和遗漏。提供可执行的下一步，负责人未知则待指定，提议日期不得写成已承诺日期。`,
  },
  {
    id: 'builtin-project-plan', name: '项目计划与交接', icon: '🗓️', kinds: ['project'],
    summary: '拆清工作包、前置依赖、交付物与验收条件，保留风险和负责人。',
    content: `用途：项目拆解、排期和协作交接。先写目标、范围与不包含的工作，再按可验收交付物拆工作包。
每个工作包记录负责人或待指定、输入、输出、前置依赖、完成标准。并行工作共享接口与术语，不让后续任务依赖尚未确认的前提。
把里程碑与具体成果关联，估算注明假设，不虚构预算和工期承诺。优先处理会阻塞后续工作的未知项。
验收逐条对应用户原始要求，完成、待验证和缺失分开说明。交接记录成果位置、使用方法、决策依据与剩余风险。`,
  },
  {
    id: 'builtin-requirements', name: '需求分析与验收', icon: '🧭', kinds: ['ppt', 'website', 'document', 'project', 'code', 'review'], roles: ['orchestrator', 'architect', 'regression'],
    summary: '把用户目标变成可检查的标准，避免擅自扩大需求或把计划当成果。',
    content: `用途：需求分析、方案设计与回归验收。保留用户原始目标，区分明确要求、合理假设与可选建议。
验收条件应当能从实际交付物检查，不擅自要求当前工作流无法提供的截图、日志、额外功能或未支持的字段。已存在的预览和导出功能不属于内容任务的新开发要求。
优先复用现有成果。缺少事实时写明假设，只有会改变主要方向的信息才值得追问。
验收引用文件、页面或实际执行结果，标明通过、缺失和待确认。结构校验、模型自评和人工批准是不同证据，不互相替代。`,
  },
  {
    id: 'builtin-code', name: '代码开发与审阅', icon: '🛠️', kinds: ['code', 'review'],
    summary: '先读相关实现，保持接口，检查正确性、安全与兼容，避免无关重写。',
    content: `用途：项目开发、修改与代码 Review。先读取相关实现和调用方，记录上下文未覆盖的部分，不声称已通读整个仓库。
遵守现有目录、接口与代码风格。围绕需求做完整而聚焦的改动，不覆盖其他协作者的成果。共享接口先约定，再并行实现。
审阅优先找可复现的正确性、权限、数据丢失、并发与兼容问题，引用位置和触发条件，避免只罗列风格偏好。
输入验证、输出转义、错误反馈和资源释放同样属于实现。不得写入密钥或绕过审批。最终说明实际变更、运行方法、验证证据和未完成部分。`,
  },
  {
    id: 'builtin-debug', name: '测试与故障排查', icon: '🧪', kinds: ['code', 'review', 'website'], roles: ['tester', 'regression', 'developer', 'frontend', 'backend'],
    summary: '从复现与证据定位原因，检查主要路径和失败路径，准确说明测试范围。',
    content: `用途：测试、回归和排错。先收集复现步骤、实际结果与预期结果，缩小故障范围，再修改原因。
选择能发现真实回归的检查，覆盖主要路径、边界与失败情况，避免只重复实现。运行命令前遵循应用审批和隔离限制。
只把实际运行成功的检查写为通过。没安装工具、缺少依赖、未联网或未执行的检查写明原因，不能用模型推断代替执行。
修改后检查原始复现与相关回归，保存简洁证据。错误日志移除凭据与个人路径，交付清楚的恢复方法。`,
  },
  {
    id: 'builtin-daily', name: '日常工作整理', icon: '☕', kinds: ['chat'],
    summary: '整理想法、会议要点和行动项，直接回答问题，避免把简单咨询变成大流程。',
    content: `用途：日常问答、资料整理和会议记录。先回答用户当前问题，简单问题简短说明，复杂内容再分层展开。
整理记录时区分已决定事项、讨论建议与未解决问题。行动项记录动作、负责人或待指定、期限或待确认。
尊重用户既有信息，不重复追问已提供内容。不把普通咨询擅自转成文件生成任务，不声称已读取链接、操作文件或调用其他模型。
需要正式成果时给出清楚的内容，复用之前确认的术语与格式，避免泛泛而谈。`,
  },
].map(skill => Object.freeze({ ...skill, source: 'builtin', version: 1 }));

export const SKILL_BUDGET = 8500; // Characters, not an advertised token estimate.
export function skillCatalog(state) {
  const disabled = new Set(state.skillPreferences?.disabledBuiltinIds || []);
  return [...BUILTIN_SKILLS.map(skill => ({ ...skill, enabled: !disabled.has(skill.id) })),
    ...(state.skills || []).map(skill => ({ ...skill, enabled: skill.enabled !== false }))];
}

export function skillKind(brief = '') {
  if (/ppt|powerpoint|幻灯片|演示文稿/i.test(brief)) return 'ppt';
  if (/网页|网站|前端界面|landing\s?page/i.test(brief)) return 'website';
  if (/代码|报错|debug|review|单元测试|bug/i.test(brief)) return 'code';
  if (/项目计划|排期|里程碑|工作包/i.test(brief)) return 'project';
  if (/报告|调研|总结|文档/i.test(brief)) return 'document';
  return 'chat';
}

export function selectSkills(state, { kind = 'chat', role = 'chat', brief = '' } = {}) {
  if (kind === 'chat') kind = skillKind(brief);
  const catalog = skillCatalog(state).filter(skill => skill.enabled && skill.content);
  const matches = skill => (!skill.kinds?.length || skill.kinds.includes(kind)) && (!skill.roles || skill.roles.includes(role));
  // Custom instructions keep priority, but cannot grow every model prompt without bound.
  const custom = catalog.filter(skill => skill.source !== 'builtin' && matches(skill)).slice(-2);
  const builtin = catalog.filter(skill => skill.source === 'builtin' && matches(skill)).slice(0, 2);
  let remaining = SKILL_BUDGET;
  return [...custom, ...builtin].map(skill => {
    const content = String(skill.content).slice(0, Math.min(3000, remaining));
    remaining -= content.length;
    return { id: skill.id, name: skill.name, source: skill.source, version: skill.version || 1, content };
  }).filter(skill => skill.content);
}

export const skillRefs = skills => skills.map(({ id, name, source, version }) => ({ id, name, source, version }));
