import {inferKind} from './providers.mjs';
import {HttpError} from './safety.mjs';

export function quickTaskInput(text) {
  if(typeof text!=='string'||text.trim().length<3||text.length>20000)throw new HttpError(400,'请用一句话说明想完成的事情（3–20000 字符）');
  const brief=text.trim();let kind=inferKind(brief);
  if(kind==='work')kind=/(?:项目计划|工作计划|里程碑|排期|项目管理|project\s*plan)/i.test(brief)?'project':'document';
  const templateValues={};
  if(kind==='ppt'){
    const count=brief.match(/(?:^|[^\d])(\d{1,3})\s*(?:页|张|slides?)/i);
    if(count){if(+count[1]<4||+count[1]>20)throw new HttpError(400,'PPT 当前支持 4–20 页，请调整需求里的页数');templateValues.slideCount=count[1];}
  }
  return {brief,kind,workflowId:kind,templateValues};
}
