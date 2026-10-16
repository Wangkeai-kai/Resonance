(() => {
  'use strict';
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const languages=new Set(['js','javascript','ts','typescript','jsx','tsx','json','py','python','java','go','rust','rs','c','cpp','cs','css','html','xml','sh','bash','sql']);
  const keywords=new Set('const let var function return async await class extends new import from export default if else for while try catch finally throw null undefined true false this public private protected static void int float boolean string String def self None True False and or not in is with as lambda pass yield async await package func type struct interface map range select chan go defer fn pub use impl mut match mod enum trait where select from where join insert update delete create table limit order by'.split(' '));
  const tokens=/(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|<\/?[A-Za-z][^>\n]{0,2000}>|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  function highlight(code,language) {
    const text=String(code);if(!languages.has(String(language).toLowerCase())||text.length>60000)return escape(text);
    let html='',offset=0;tokens.lastIndex=0;
    for(const match of text.matchAll(tokens)){
      html+=escape(text.slice(offset,match.index));const token=match[0];let kind='';
      if(/^(?:\/\/|\/\*|#)/.test(token))kind='comment';else if(/^["'`]/.test(token))kind='string';else if(/^\d/.test(token))kind='number';else if(token.startsWith('<'))kind='tag';else if(keywords.has(token))kind='keyword';
      html+=kind?`<span class="code-${kind}">${escape(token)}</span>`:escape(token);offset=match.index+token.length;
    }
    return html+escape(text.slice(offset));
  }
  const api=Object.freeze({highlight});if(typeof module!=='undefined')module.exports=api;if(typeof window!=='undefined')window.CodeHighlight=api;
})();
