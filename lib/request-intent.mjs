// This guard catches conversational questions accidentally submitted while the
// composer still says task. Explicit deliverable requests keep the workflow.
export function isConversationQuestion(value){
  const text=String(value||'').trim();
  if(!text||text.length>500)return false;
  if(/^(?:你好|您好|在吗|谢谢|测试|123|hi|hello)[!！。\s]*$/i.test(text))return true;
  if(/(?:制作|生成|撰写|写一|做一|开发|实现|修复|重构|导出|输出.{0,8}(?:文件|报告|方案)|写.{0,8}(?:报告|文档|方案)|build|create|implement|generate)/i.test(text))return false;
  return /(?:为什么|为何|是否|是不是|能不能|有几个|有哪些|why\b)/i.test(text)||/^(?:请问|我想问|怎么|如何|能否|可不可以|你(?:能|会|有|是|管|调|负责)|谁|what\b|how\b|can\s+you\b|are\s+you\b)/i.test(text);
}
