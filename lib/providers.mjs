import { HttpError, validateProvider } from './safety.mjs';

// Presets describe services, not a frozen model catalog. New connections discover
// account models or use an explicit model ID, then send one small compatibility test.
export const PRESETS = Object.freeze([
  {id:'openai',name:'OpenAI · GPT',type:'openai',baseUrl:'https://api.openai.com/v1',model:'',hint:'填写 OpenAI API Key，读取账号可用模型；ChatGPT 订阅在“订阅 / 编码工具”中连接。'},
  {id:'anthropic',name:'Anthropic · Claude',type:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'',hint:'填写 Anthropic API Key，读取账号可用的 Claude 版本。'},
  {id:'deepseek',name:'DeepSeek',type:'openai',baseUrl:'https://api.deepseek.com/v1',model:'',hint:'填写 DeepSeek API Key，读取账号可用版本；对话和推理模型都可选择。'},
  {id:'gemini',name:'Google · Gemini',type:'openai',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',model:'',hint:'填写 Google AI Studio API Key，读取账号可用版本；可用性取决于账号与地区。'},
  {id:'qwen',name:'通义千问 · Qwen',type:'openai',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'',hint:'读取账号可用版本；默认阿里云百炼中国内地接入点，其他区域可修改地址。'},
  {id:'moonshot',name:'月之暗面 · Kimi',type:'openai',baseUrl:'https://api.moonshot.cn/v1',model:'',hint:'填写 Moonshot API Key，读取账号实际开放的 Kimi 版本；模型 ID 以服务商返回为准。'},
  {id:'zhipu',name:'智谱 · GLM',type:'openai',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'',hint:'读取账号可用版本；使用智谱开放平台通用 API Key，专用套餐可能需要修改地址。'},
  {id:'siliconflow',name:'硅基流动',type:'openai',baseUrl:'https://api.siliconflow.cn/v1',model:'',hint:'读取账号可用模型；对话和推理模型都可选择，连接时会检查兼容性。'},
  {id:'ollama',name:'Ollama · 本地',type:'openai',baseUrl:'http://127.0.0.1:11434/v1',model:'',hint:'先启动 Ollama 并下载一个聊天模型；无需 API Key。'},
  {id:'lmstudio',name:'LM Studio · 本地',type:'openai',baseUrl:'http://127.0.0.1:1234/v1',model:'',hint:'先在 LM Studio 加载模型并启动 Local Server；无需 API Key。'},
  {id:'custom',name:'自定义兼容服务',type:'openai',baseUrl:'',model:'',hint:'填写兼容 OpenAI 的服务地址、模型 ID 和所需 API Key。'},
]);

export const isLocalUrl = value => ['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname);
export const isChatModel = model => !/(?:embed|rerank|whisper|tts|dall-e|moderation|transcrib|realtime|image|audio|stable-diffusion|flux)/i.test(model);
const isReasoningModel = model => /(?:^|[-_/])(?:o1|o3|o4|r1)(?:[-_/]|$)|reasoner|thinking/i.test(model);

export async function discoverModels(provider, apiKey, timeout=8000) {
  const headers={Accept:'application/json'};
  if(provider.type==='anthropic'){headers['anthropic-version']='2023-06-01';if(apiKey)headers['x-api-key']=apiKey;}
  else if(apiKey)headers.Authorization=`Bearer ${apiKey}`;
  const base=provider.type==='anthropic' && new URL(provider.baseUrl).pathname.replace(/\/$/,'')===''?`${provider.baseUrl}/v1`:provider.baseUrl;
  const response=await fetch(`${base}/models`,{headers,signal:AbortSignal.timeout(timeout),redirect:'error'});
  if(!response.ok)throw new Error(`无法读取模型列表（HTTP ${response.status}）`);
  const raw=await response.text();if(raw.length>2000000)throw new Error('模型列表过大');
  const data=JSON.parse(raw);if(!Array.isArray(data.data))throw new Error('服务未返回兼容的模型列表');
  return data.data.filter(m=>typeof m.id==='string' && m.id.length>0 && m.id.length<=160).slice(0,1000).map(m=>({id:m.id,name:String(m.name||m.display_name||m.id).slice(0,180)}));
}

export function chooseModel(models, preferred='') {
  if(preferred && models.some(m=>m.id===preferred))return preferred;
  const candidates=models.filter(m=>isChatModel(m.id));
  // Preserve the service's order instead of preferring a frozen model/version.
  // Reasoning models remain selectable, including when they are the only choice.
  // A model listing alone never guarantees price, recency or API compatibility.
  return (candidates.find(m=>!isReasoningModel(m.id)) || candidates[0])?.id || '';
}

export async function detectLocalProviders() {
  const providers=await Promise.all(PRESETS.filter(p=>['ollama','lmstudio'].includes(p.id)).map(async preset=>{
    try{const models=await discoverModels(preset,'',2000);return {presetId:preset.id,name:preset.name,baseUrl:preset.baseUrl,models:models.filter(m=>isChatModel(m.id)),model:chooseModel(models),available:true};}
    catch{return {presetId:preset.id,name:preset.name,baseUrl:preset.baseUrl,models:[],model:'',available:false};}
  }));
  return {providers};
}

export function connectionCandidate(input, previousProviders, keys) {
  const preset=PRESETS.find(p=>p.id===input.presetId);if(!preset)throw new HttpError(400,'请选择支持的模型服务');
  if(Object.hasOwn(input,'connectionId') && typeof input.connectionId!=='string')throw new HttpError(400,'模型连接 ID 必须为字符串');
  if(Object.hasOwn(input,'sourceConnectionId') && (typeof input.sourceConnectionId!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.sourceConnectionId)))throw new HttpError(400,'复用来源连接 ID 无效');
  const raw={id:Object.hasOwn(input,'connectionId')?input.connectionId:preset.id,name:String(input.name||preset.name).trim(),type:preset.type,baseUrl:String(input.baseUrl||preset.baseUrl).trim(),model:String(input.model||preset.model||'discovery-pending').trim()};
  const provider=validateProvider(raw);const old=previousProviders.find(p=>p.id===(input.sourceConnectionId||provider.id));
  if(input.thinkingMode!==undefined)provider.thinkingMode=validateProvider({...provider,thinkingMode:input.thinkingMode}).thinkingMode;
  else if(old?.baseUrl===provider.baseUrl&&old?.type===provider.type&&old.thinkingMode)provider.thinkingMode=old.thinkingMode;
  if(input.sourceConnectionId && !old)throw new HttpError(400,'原模型连接已不存在，请重新填写 API Key');
  const hasNewKey=Object.hasOwn(input,'apiKey');
  const apiKey=hasNewKey?String(input.apiKey||'').trim():(old?.baseUrl===provider.baseUrl && old?.type===provider.type?keys.get(old.id)||'':'');
  if(apiKey.length>16000 || /[\r\n]/.test(apiKey))throw new HttpError(400,'API Key 格式无效');
  if(!isLocalUrl(provider.baseUrl) && !apiKey)throw new HttpError(400,'请填写此服务的 API Key；修改服务地址后需重新填写');
  return {provider,apiKey,preset,explicitModel:Boolean(input.model)};
}

export function inferKind(brief, requested='auto') {
  if(requested && requested!=='auto')return String(requested).slice(0,40);
  if(/(?:现有|已有|当前|这个|这份|existing|current).{0,12}(?:项目|代码|仓库|repo|code)|(?:修复|调试|重构|评审|审查|review|debug|refactor).{0,20}(?:代码|bug|仓库|接口|code|repo)|(?:修复|fix)\s*bug|代码\s*review/i.test(brief))return 'code';
  if(/ppt|powerpoint|幻灯片|演示文稿|路演|presentation/i.test(brief))return 'ppt';
  if(/网页|网站|落地页|website|landing\s*page|web\s*app/i.test(brief))return 'website';
  return 'work';
}
