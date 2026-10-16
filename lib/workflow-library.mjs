import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError} from './safety.mjs';
import {saveSnapshot, exists} from './local-snapshot.mjs';
import {WORKFLOWS, buildWorkflow} from './workflows.mjs';

export const WORKFLOW_FORMAT = 'gongming-workflow@1';
const STORAGE_FORMAT = 'gongming-workflow-library@1';
const STAGES = ['orchestrator', 'context', 'architect', 'developer', 'tester', 'docs', 'regression', 'git'];
const ICONS = {website:'🌐', ppt:'📊', document:'📝', project:'📁', code:'🛠️'};
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DOCUMENT_BYTES = 128 * 1024;
const CAPABILITIES = Object.freeze({
  format: WORKFLOW_FORMAT,
  importSources: ['file', 'conversation'],
  urlImport: false,
  kinds: WORKFLOWS.map(workflow => workflow.kind),
  customStages: false, modelOverrides: false, skillOverrides: false, mcpOverrides: false,
  confirmationRequired: true,
  stages: STAGES,
  limitations: [
    '工作流复用现有受审批保护的执行流程；不允许导入 shell 命令、跳过审批或任意工具权限。',
    '模型、技能和 MCP 使用工作台当前配置；运行前请在任务确认页检查。',
    '支持本地 JSON 文件与从对话保存；URL 导入尚未启用，请先下载文件再导入。',
  ],
});

function fail(message, status = 400, code = 'workflow_library_invalid') {
  throw new HttpError(status, message, code);
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须为对象`);
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (RESERVED.has(key) || !allowed.includes(key)) fail(`${label}包含不支持的字段 ${key}；不能忽略未实现的权限或执行配置`, 400, 'workflow_capability_unsupported');
  }
}
function string(value, label, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) fail(`${label}需为不含控制字符的文本，最多 ${max} 字符`);
  return value.trim();
}
function boolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label}必须为布尔值`);
  return value;
}
function builtin(kind) {
  const workflow = WORKFLOWS.find(item => item.kind === kind);
  if (!workflow) fail('请选择支持的工作流类型：' + WORKFLOWS.map(item => item.kind).join('、'));
  return workflow;
}
function emptyOverride(value, name, expected) {
  if (value === undefined) return;
  if (expected === 'array' && Array.isArray(value) && value.length === 0) return;
  if (expected === 'object' && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
  fail(`${name}覆盖暂不支持；请移除该配置，并在工作台中选择后确认运行`, 400, 'workflow_capability_unsupported');
}

/** Validate a declarative prompt/form, never executable code or authority. */
export function validateWorkflowDefinition(input) {
  object(input, '工作流');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { fail('工作流必须为可序列化 JSON'); }
  if (size > MAX_DOCUMENT_BYTES) fail('工作流文件超过 128 KB', 413);
  keys(input, ['format','name','icon','description','version','author','trigger','inputs','pipeline','skills','model','constraints'], '工作流');
  if (input.format !== WORKFLOW_FORMAT) fail(`工作流 format 必须为 ${WORKFLOW_FORMAT}`);
  const name = string(input.name, '名称', 80);
  if (!name) fail('请填写工作流名称');
  keys(input.trigger, ['kind','starterPrompt','templateValues'], 'trigger');
  const template = builtin(input.trigger.kind);
  const starterPrompt = string(input.trigger.starterPrompt, '提示词模板', 20000);
  if (!starterPrompt) fail('请填写提示词模板');
  const fields = new Set(template.fields.map(field => field.id));
  const defaults = input.trigger.templateValues ?? {};
  object(defaults, '固定模板参数');
  for (const key of Object.keys(defaults)) if (!fields.has(key) || RESERVED.has(key)) fail(`固定模板参数不支持 ${key}`);
  const templateValues = {};
  for (const [key, value] of Object.entries(defaults)) templateValues[key] = string(value, key, key === 'materials' ? 12000 : 2000);
  // Validate built-in formats (for example slide count) at import time too.
  buildWorkflow({workflowId: template.id, brief: 'validate', templateValues});

  if (input.pipeline !== undefined) {
    keys(input.pipeline, ['stages','skipStages'], 'pipeline');
    if (input.pipeline.stages !== undefined && JSON.stringify(input.pipeline.stages) !== JSON.stringify(STAGES)) fail('自定义阶段顺序暂不支持；需使用工作台完整标准流程', 400, 'workflow_capability_unsupported');
    if (input.pipeline.skipStages !== undefined && (!Array.isArray(input.pipeline.skipStages) || input.pipeline.skipStages.length)) fail('导入工作流不能跳过标准流程阶段或审批', 400, 'workflow_capability_unsupported');
  }
  emptyOverride(input.skills, 'skills', 'array');
  emptyOverride(input.model, 'model', 'object');
  emptyOverride(input.constraints, 'constraints', 'object');

  if (input.inputs !== undefined && (!Array.isArray(input.inputs) || input.inputs.length > 32)) fail('inputs 必须为数组，最多 32 项');
  const used = new Set(), targets = new Set();
  const inputs = (input.inputs ?? []).map((field, index) => {
    keys(field, ['key','label','required','multiline','default','placeholder','target'], `输入项 ${index + 1}`);
    const key = string(field.key, '输入键', 48);
    if (!KEY.test(key) || RESERVED.has(key) || used.has(key)) fail('输入键必须是唯一的英文字母、数字或下划线，且以字母开头');
    used.add(key);
    const label = string(field.label, '输入名称', 80);
    if (!label) fail('每个输入项需有名称');
    const result = {key, label, required:boolean(field.required, 'required'), multiline:boolean(field.multiline, 'multiline')};
    if (field.default !== undefined) result.default = string(field.default, '默认值', 12000);
    if (field.placeholder !== undefined) result.placeholder = string(field.placeholder, '提示文字', 500);
    if (field.target !== undefined) {
      const target = string(field.target, '模板参数映射', 48);
      if (!fields.has(target) || targets.has(target)) fail('模板参数映射必须唯一，且属于所选工作流的参数');
      targets.add(target); result.target = target;
    }
    return result;
  });
  const placeholders = new Set([...starterPrompt.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => match[1]));
  for (const key of placeholders) if (!used.has(key)) fail(`提示词使用了未定义输入：{{${key}}}`);
  if (starterPrompt.replace(/\{\{[^{}]*\}\}/g, '').match(/[{}]{2}/)) fail('提示词模板仅支持 {{输入键}}，不支持表达式或嵌套模板');
  for (const field of inputs) if (!field.target && !placeholders.has(field.key)) fail(`输入 ${field.label} 未用于提示词或模板参数，无法实际生效`);
  return {
    format: WORKFLOW_FORMAT, name,
    icon: string(input.icon, '图标', 16, ICONS[template.id]),
    description: string(input.description, '简介', 2000),
    version: string(input.version, '版本', 40, '1.0.0'),
    author: string(input.author, '作者', 120),
    trigger: {kind: template.kind, starterPrompt, ...(Object.keys(templateValues).length ? {templateValues} : {})},
    pipeline: {stages: [...STAGES], skipStages: []}, inputs,
  };
}

function builtinDefinition(workflow) {
  return validateWorkflowDefinition({
    format:WORKFLOW_FORMAT, name:workflow.title, icon:ICONS[workflow.id], description:workflow.description,
    version:'1.0.0', author:'Resonance', trigger:{kind:workflow.kind,starterPrompt:'{{description}}'},
    inputs:[{key:'description',label:'你想完成什么',required:true,multiline:true},
      ...workflow.fields.map(field => ({key:field.id,label:field.label,target:field.id,multiline:['materials','acceptance','structure'].includes(field.id),...(field.default ? {default:field.default} : {}),placeholder:field.placeholder}))],
  });
}

export class WorkflowLibrary {
  constructor(engine) {
    this.engine = engine;
    this.file = path.join(engine.runtime, 'workflow-library.json');
    this.data = {format:STORAGE_FORMAT, entries:[], preferences:{}};
    this.chain = Promise.resolve();
  }
  async init() {
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (await exists(this.file.replace(/\.json$/, '.previous.json'))) throw Object.assign(new Error('工作流主记录缺失，但发现备份；请恢复文件后启动'), {code:'history_recovery_required'});
      return this;
    }
    try {
      if (Buffer.byteLength(raw) > 24 * 1024 * 1024) throw Error('记录过大');
      const data = JSON.parse(raw);
      keys(data, ['format','entries','preferences'], '工作流记录');
      if (data.format !== STORAGE_FORMAT || !Array.isArray(data.entries) || data.entries.length > 2000) throw Error('格式无效');
      const ids = new Set();
      const entries = data.entries.map(entry => {
        keys(entry, ['id','source','definition','createdAt','updatedAt'], '工作流记录项');
        if (typeof entry.id !== 'string' || !/^flow-[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || !['imported','custom'].includes(entry.source)) throw Error('标识无效');
        ids.add(entry.id);
        for (const time of ['createdAt','updatedAt']) if (typeof entry[time] !== 'string' || !Number.isFinite(Date.parse(entry[time]))) throw Error('时间无效');
        return {...entry,definition:validateWorkflowDefinition(entry.definition)};
      });
      object(data.preferences, '工作流偏好');
      const allowed = new Set([...WORKFLOWS.map(item => 'builtin-' + item.id), ...ids]);
      for (const [key, value] of Object.entries(data.preferences)) {
        if (!allowed.has(key)) throw Error('偏好标识无效');
        keys(value, ['pinned','order'], '工作流偏好项');
        if (typeof value.pinned !== 'boolean' || !Number.isSafeInteger(value.order) || value.order < 0) throw Error('偏好格式无效');
      }
      this.data = {...data, entries};
    } catch {
      throw Object.assign(new Error('工作流记录损坏；已保留原文件，请恢复备份后启动'), {code:'workflow_library_invalid'});
    }
    return this;
  }
  list() {
    const builtins = WORKFLOWS.map((workflow, index) => ({id:'builtin-' + workflow.id,source:'builtin',definition:builtinDefinition(workflow),defaultOrder:index}));
    const entries = [...builtins, ...this.data.entries.map((entry,index) => ({...entry, defaultOrder:WORKFLOWS.length+index}))];
    return entries.map(entry => {
      const pref = this.data.preferences[entry.id];
      const {defaultOrder, ...item} = entry;
      return {...item,name:entry.definition.name,title:entry.definition.name,icon:entry.definition.icon,description:entry.definition.description,kind:entry.definition.trigger.kind,pinned:pref?.pinned ?? ['builtin-website','builtin-ppt'].includes(entry.id),order:pref?.order ?? defaultOrder};
    }).sort((a,b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  status() { return structuredClone({workflows:this.list(),capabilities:CAPABILITIES}); }
  get(id) {
    const item = this.list().find(entry => entry.id === id);
    if (!item) fail('工作流不存在，请刷新列表', 404, 'workflow_not_found');
    return item;
  }
  export(id) { return structuredClone(this.get(id).definition); }
  transaction(operation) {
    const pending = this.chain.then(async () => {
      const previous = structuredClone(this.data);
      try {
        const result = await operation();
        const snapshot = JSON.stringify(this.data, null, 2);
        if (Buffer.byteLength(snapshot) > 24 * 1024 * 1024) fail('工作流库超过 24 MB，请先导出并整理较大的模板', 409);
        await saveSnapshot(this.file, snapshot);
        return result;
      } catch (error) { this.data = previous; throw error; }
    });
    this.chain = pending.catch(() => {});
    return pending;
  }
  async create(input) {
    keys(input, ['action','definition'], '保存工作流请求');
    if (!['create','import'].includes(input.action)) fail('请选择新建或导入工作流');
    const definition = validateWorkflowDefinition(input.definition);
    return this.transaction(() => {
      if (this.data.entries.length >= 2000) fail('工作流记录达到 2000 项，请先导出并整理', 409);
      const time = new Date().toISOString();
      const entry = {id:'flow-' + randomUUID(),source:input.action === 'import' ? 'imported' : 'custom',definition,createdAt:time,updatedAt:time};
      const order = this.list().length;
      this.data.entries.push(entry);
      this.data.preferences[entry.id] = {pinned:false,order};
      return {workflow:this.get(entry.id),...this.status()};
    });
  }
  async update(id, input) {
    keys(input, ['action','definition','pinned','beforeId'], '更新工作流请求');
    return this.transaction(() => {
      const item = this.get(id);
      if (input.action === 'update') {
        if (item.source === 'builtin') fail('内置工作流不能覆盖，请另存为自建工作流', 409);
        const entry = this.data.entries.find(entry => entry.id === id);
        entry.definition = validateWorkflowDefinition(input.definition);
        entry.updatedAt = new Date().toISOString();
      } else if (input.action === 'pin') {
        if (typeof input.pinned !== 'boolean') fail('pinned 必须为布尔值');
        this.data.preferences[id] = {order:item.order,pinned:input.pinned};
      } else if (input.action === 'order') {
        if (input.beforeId !== null && typeof input.beforeId !== 'string') fail('beforeId 需为工作流标识或 null');
        const all = this.list();
        if (input.beforeId && !all.some(entry => entry.id === input.beforeId)) fail('排序目标工作流不存在', 404);
        if (input.beforeId !== id) {
          const rest = all.filter(entry => entry.id !== id);
          rest.splice(input.beforeId === null ? rest.length : rest.findIndex(entry => entry.id === input.beforeId), 0, item);
          rest.forEach((entry, index) => { this.data.preferences[entry.id] = {pinned:entry.pinned,order:index}; });
        }
      } else fail('不支持此工作流操作');
      return {workflow:this.get(id),...this.status()};
    });
  }
  async remove(id) {
    return this.transaction(() => {
      if (this.get(id).source === 'builtin') fail('内置工作流不能删除，可以取消钉住', 409);
      this.data.entries = this.data.entries.filter(entry => entry.id !== id);
      delete this.data.preferences[id];
      this.list().forEach((entry,index) => { this.data.preferences[entry.id] = {pinned:entry.pinned,order:index}; });
      return this.status();
    });
  }
  prepare(id, input = {}) {
    keys(input, ['inputs'], '工作流运行参数');
    const workflow = this.get(id), definition = workflow.definition;
    const supplied = input.inputs ?? {};
    object(supplied, '工作流输入');
    const allowed = new Set(definition.inputs.map(field => field.key));
    for (const key of Object.keys(supplied)) if (!allowed.has(key) || RESERVED.has(key)) fail(`不支持的工作流输入：${key}`);
    const values = {}, templateValues = {...definition.trigger.templateValues};
    for (const field of definition.inputs) {
      const value = string(supplied[field.key] ?? field.default ?? '', field.label, 12000);
      if (field.required && !value) fail(`请填写${field.label}`);
      values[field.key] = value;
      if (field.target) templateValues[field.target] = value;
    }
    const brief = definition.trigger.starterPrompt.replace(/\{\{([^{}]*)\}\}/g, (_, key) => values[key]);
    if (!brief.trim() || brief.length > 20000) fail('生成的需求需为非空文本，最多 20,000 字符');
    const prepared = buildWorkflow({workflowId:definition.trigger.kind,brief,templateValues});
    return {
      workflowId:prepared.workflow.id, brief:prepared.brief, templateValues:prepared.workflow.values,
      libraryWorkflowId:id, requiresConfirmation:true, workflow:structuredClone(workflow),
      capabilities:structuredClone(CAPABILITIES),
      modelAssignments:structuredClone(this.engine.state?.config?.agentProviders ?? {}),
      enabledSkills:(this.engine.state?.skills ?? []).filter(skill => skill.enabled !== false).map(skill => ({id:skill.id,name:skill.name})),
      notice:'准备完成，尚未调用模型。请检查当前模型、技能、预算与审批设置后再创建任务。',
    };
  }
}
