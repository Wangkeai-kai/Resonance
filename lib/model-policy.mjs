export function deepSeekThinking(provider){
  let host;try{host=new URL(provider.baseUrl).hostname.toLowerCase();}catch{return null;}
  if(provider.type!=='openai'||host!=='api.deepseek.com'||!/^deepseek-(?:flash|v4-pro)$/.test(provider.model))return null;
  // Current official API defaults to enabled/high. Use a fast default for
  // interactive work unless the user explicitly requests deep thinking.
  return {type:provider.thinkingMode==='enabled'?'enabled':'disabled'};
}
