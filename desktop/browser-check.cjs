'use strict';
const {BrowserWindow,session}=require('electron');
const {randomUUID}=require('node:crypto');

async function runBrowserCheck(html,steps=[]) {
  if(typeof html!=='string'||Buffer.byteLength(html)>2*1024*1024)throw new Error('browser_input_limit');
  if(!Array.isArray(steps)||steps.length>20)throw new Error('browser_steps_invalid');
  for(const step of steps)if(!['click','fill','visible','text'].includes(step?.action)||typeof step.selector!=='string'||step.selector.length>300||String(step.value||'').length>2000)throw new Error('browser_step_invalid');
  const isolated=session.fromPartition('gongming-browser-check-'+randomUUID());
  isolated.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  isolated.setPermissionCheckHandler(()=>false);
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')&&!details.url.startsWith('about:')}));
  const window=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,disableDialogs:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  // Policy precedes every byte of generated markup, including malformed HTML
  // or a script before <head>. Never let generated content select the origin.
  const protectedHtml='<meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>window.__gongmingErrors=0;addEventListener("error",()=>window.__gongmingErrors++);addEventListener("unhandledrejection",()=>window.__gongmingErrors++);</script>'+html;
  const deadline=setTimeout(()=>window.destroy(),15000);deadline.unref?.();
  try {
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(protectedHtml));
    const checks=[];
    for(const width of [390,768,1440]){
      window.setContentSize(width,900);await new Promise(resolve=>setTimeout(resolve,100));
      const result=await window.webContents.executeJavaScript('({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+2,title:document.title,buttons:[...document.querySelectorAll("button")].filter(e=>!e.getAttribute("aria-label")&&!e.textContent.trim()).length,images:[...document.images].filter(e=>!e.hasAttribute("alt")).length})');
      checks.push({id:'viewport_'+width,status:result.overflow?'failed':'passed',evidence:width+'px：'+(result.overflow?'存在横向溢出':'无横向溢出')});
      if(width===1440){checks.push({id:'button_names',status:result.buttons?'failed':'passed',evidence:'无名称按钮：'+result.buttons});checks.push({id:'image_alt',status:result.images?'failed':'passed',evidence:'缺少 alt 的图片：'+result.images});}
    }
    for(let index=0;index<steps.length;index++){
      const result=await window.webContents.executeJavaScript('('+function(step){
        const element=document.querySelector(step.selector);if(!element)return false;
        if(step.action==='click'){element.click();return true;}
        if(step.action==='fill'){if(!('value'in element))return false;element.value=step.value||'';element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true;}
        if(step.action==='visible')return !!(element.getClientRects().length)&&getComputedStyle(element).visibility!=='hidden';
        return element.textContent.includes(step.value||'');
      }.toString()+')('+JSON.stringify(steps[index])+')');
      await new Promise(resolve=>setTimeout(resolve,50));checks.push({id:'interaction_'+(index+1),status:result?'passed':'failed',evidence:steps[index].action+' '+steps[index].selector});
    }
    const errors=await window.webContents.executeJavaScript('window.__gongmingErrors||0');checks.push({id:'browser_errors',status:errors?'failed':'passed',evidence:'页面异常数：'+errors});
    return {status:checks.every(check=>check.status==='passed')?'passed':'failed',scope:'isolated_browser_dom',checks,limitations:['浏览器测试无网络、无文件和本机工具权限。','检查了指定宽度、基本可访问性与给定交互步骤；不代表完整业务、跨浏览器或 WCAG 认证。']};
  }finally{clearTimeout(deadline);if(!window.isDestroyed())window.destroy();await isolated.clearStorageData();}
}
module.exports={runBrowserCheck};
