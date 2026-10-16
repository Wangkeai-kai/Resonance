import path from 'node:path';
import {HttpError} from './safety.mjs';

const fail=message=>{throw new HttpError(400,message);};
const tagAttributes=source=>{
  const attributes=new Map();let cursor=0;
  const expression=/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
  while(cursor<source.length){
    while(cursor<source.length&&/\s/.test(source[cursor]))cursor++;
    if(cursor===source.length||/^\/\s*$/.test(source.slice(cursor)))break;
    expression.lastIndex=cursor;const match=expression.exec(source);
    if(!match)fail('网站资源标签格式无效，请使用标准 script / link 标签。');
    const name=match[1].toLowerCase();if(attributes.has(name))fail('网站资源标签含重复属性：'+name);
    attributes.set(name,match[2]??match[3]??match[4]??'');cursor=expression.lastIndex;
  }
  return attributes;
};
function checkScript(source){
  // A compatibility guard, not a JavaScript security parser. The isolated
  // renderer's CSP remains the boundary for every generated script.
  const tokens=source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(?:import|export)\b|[\s\S]/g)||[];
  let code='';for(const token of tokens){
    if(token.startsWith('//')||token.startsWith('/*'))continue;
    if(token[0]==='`'&&token.includes('${')&&/\bimport\s*\(/.test(token))fail('预览不支持模块导入，请先将 JS 依赖打包为普通脚本。');
    code+=['"',"'",'`'].includes(token[0])?'""':token;
  }
  if(/(?:^|[^\w$.])import\s*(?:\(|["'{*\w])|(?:^|[^\w$.])export\s+(?:default|const|let|var|function|class|\{|\*)/.test(code))fail('预览不支持模块导入，请先将 JS 依赖打包为普通脚本。');
}
function checkStyle(source){
  const css=source.replace(/\/\*[\s\S]*?\*\//g,'');
  if(/@import\b/i.test(css))fail('预览不支持 CSS @import，请将样式合并到本地 CSS 文件。');
  for(const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi))if(!/^data:/i.test((match[1]??match[2]??match[3]??'').trim()))fail('CSS 图片与字体请使用 data URL 嵌入，预览不加载外部或未打包资源。');
}

// Comments and raw-text elements are matched as a unit so example markup in
// them cannot be interpreted as an actual script or stylesheet reference.
export function bundleWebsite(files) {
  const map=new Map();for(const file of files){if(typeof file?.path!=='string'||typeof file.content!=='string'||map.has(file.path))fail('网站文件列表无效或包含重复路径。');map.set(file.path,file.content);}
  let html=map.get('index.html');if(typeof html!=='string')fail('网站需要 index.html');
  const asset=(value,extension)=>{
    if(typeof value!=='string'||!value||/^(?:[a-z]+:|\/)|[\\?#&%\u0000-\u001f]/i.test(value))fail('预览只加载项目内相对路径的 JS / CSS；远程资源请改为本地文件。');
    const normalized=path.posix.normalize(value);if(normalized.startsWith('../')||!map.has(normalized))fail('网站引用的本地文件不存在：'+normalized);
    if(path.posix.extname(normalized).toLowerCase()!==extension)fail('网站资源类型不匹配：'+normalized);
    return map.get(normalized);
  };
  const deferred=[];
  const tags=/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>|<(link|script)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>|<(script|link)\b[^>]*>/gi;
  html=html.replace(tags,(whole,rawTag,rawAttributes,body,openTag,openAttributes,malformedTag)=>{
    if(whole.startsWith('<!--'))return whole;
    if(malformedTag)fail('网站资源标签格式无效，请补全引号和结束标签。');
    const tag=(rawTag||openTag).toLowerCase();if(['textarea','title'].includes(tag))return whole;
    if(tag==='style'){checkStyle(body);return whole;}
    const attributes=tagAttributes(rawAttributes??openAttributes);
    if(tag==='link'){
      const rel=(attributes.get('rel')||'').toLowerCase().split(/\s+/);
      if(!rel.includes('stylesheet')){
        if(rel.some(value=>['modulepreload','preload','import'].includes(value)))fail('预览不加载预取或模块资源，请先打包项目依赖。');
        return whole;
      }
      if(!attributes.has('href'))fail('样式标签缺少 href。');
      const css=asset(attributes.get('href'),'.css');checkStyle(css);
      const media=attributes.get('media');if(media&&/["<>]/.test(media))fail('样式 media 属性无效。');
      return '<style'+(media?' media="'+media.replaceAll('&','&amp;')+'"':'')+(attributes.has('disabled')?' disabled':'')+'>'+css.replace(/<\/style/gi,'<\\/style')+'</style>';
    }
    if(!rawTag)fail('脚本标签必须包含结束标签。');
    const type=(attributes.get('type')||'').trim().toLowerCase();
    if(type==='module')fail('预览需要浏览器可直接运行的脚本；请先将模块打包为普通 JS。');
    if(!attributes.has('src')){if(!type||['text/javascript','application/javascript'].includes(type))checkScript(body||'');return whole;}
    if(type&&!['text/javascript','application/javascript'].includes(type))fail('本地脚本需要使用标准 JavaScript 类型。');
    if(body.trim())fail('外部脚本不能同时包含内联内容。');
    if(attributes.has('async'))fail('预览不支持 async 资源脚本，请改用 defer 保持加载顺序。');
    const script=asset(attributes.get('src'),'.js');checkScript(script);
    const output='<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>';
    if(attributes.has('defer')){deferred.push(output);return '';}
    return output;
  });
  // An inline script cannot retain defer. Execute these after all source
  // markup and ordinary scripts, in their original relative order.
  if(deferred.length)html+=deferred.join('');
  return html;
}
