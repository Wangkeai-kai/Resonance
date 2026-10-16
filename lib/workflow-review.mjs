import {hash,HttpError,now,id} from './safety.mjs';
import {validateWorkflowArtifact} from './workflows.mjs';

const pendingReviews=new WeakMap();

export function workflowReview(job) {
  if(!job.deliverable?.artifact)throw new HttpError(409,'任务尚未生成可以审阅的成果');
  const sourceHash=hash(job.deliverable.artifact);
  if(!job.review || job.review.sourceHash!==sourceHash){
    if(job.review)job.reviewHistory=[job.review,...(job.reviewHistory||[])].slice(0,3);
    job.review={sourceHash,versions:[{artifact:structuredClone(job.deliverable.artifact),note:'模型初稿',at:now()}],comments:[],approved:false};
  }
  return job.review;
}

export function applyWorkflowReview(engine,job,input) {
  const operation=(pendingReviews.get(job)||Promise.resolve()).then(()=>saveWorkflowReview(engine,job,input));
  const settled=operation.catch(()=>{});pendingReviews.set(job,settled);
  void settled.then(()=>{if(pendingReviews.get(job)===settled)pendingReviews.delete(job);});
  return operation;
}

async function saveWorkflowReview(engine,job,input) {
  const draftAvailable=['failed','interrupted'].includes(job.status)&&job.deliverable?.artifact&&job.tasks?.some(task=>task.id==='tester'&&task.status==='completed');
  if(engine.active?.has(job.id)||(job.status!=='completed'&&!draftAvailable))throw new HttpError(409,'当前成果仍在制作或结构尚未检查，暂时不能保存审阅');
  if(job.status!=='completed'&&input?.action==='approve')throw new HttpError(409,'验收尚未通过，可以批注、编辑和导出初稿，暂不能确认定稿');
  if(!input || typeof input!=='object' || Array.isArray(input))throw new HttpError(400,'审阅操作必须为对象');
  // Validate against a draft; even initializing a new source version must not
  // change saved history when a stale or invalid request is rejected.
  const draft={...job,...(job.review?{review:structuredClone(job.review)}:{})};
  const review=workflowReview(draft);
  if(input.sourceHash!==review.sourceHash || input.version!==review.versions.length)throw new HttpError(409,'成果版本已变化，请重新打开后再保存');
  if(input.action==='comment'){
    const text=typeof input.text==='string'?input.text.trim():'';if(!text || text.length>2000 || review.comments.length>=200)throw new HttpError(400,'意见需为1–2000字，最多200条');
    const slide=input.slide===undefined?0:input.slide;const artifact=review.versions.at(-1).artifact;
    if(!Number.isInteger(slide)||slide<0||slide>=(artifact.slides?.length||1))throw new HttpError(400,'审阅位置无效');
    review.comments.push({id:id('comment'),text,slide,version:review.versions.length,resolved:false,at:now()});review.approved=false;
  }else if(input.action==='resolve'){
    const comment=review.comments.find(c=>c.id===input.commentId);if(!comment)throw new HttpError(404,'未找到审阅意见');
    if(typeof input.resolved!=='boolean')throw new HttpError(400,'意见处理状态必须为布尔值');
    comment.resolved=input.resolved;review.approved=false;
  }else if(input.action==='edit-slide'){
    const current=review.versions.at(-1).artifact;
    if(current.kind!=='ppt')throw new HttpError(400,'此成果不支持逐页编辑');
    if(review.versions.length>=12)throw new HttpError(400,'已保留12个版本，请导出后继续编辑');
    const index=input.slide;if(!Number.isInteger(index)||index<0||index>=current.slides.length)throw new HttpError(400,'页面不存在');
    const edited=structuredClone(current);const slide=input.content;
    if(!slide||typeof slide!=='object')throw new HttpError(400,'请填写页面内容');
    edited.slides[index]={...edited.slides[index],title:slide.title,subtitle:slide.subtitle,items:slide.items,...(slide.layout!==undefined?{layout:slide.layout}:{})};
    if(index===0)edited.title=slide.title;
    const checked=validateWorkflowArtifact('ppt',[{path:'artifacts/presentation.json',content:JSON.stringify(edited)}]);
    review.versions.push({artifact:checked.artifact,note:`修改第 ${index+1} 页`,at:now()});review.approved=false;
  }else if(input.action==='approve'){
    if(review.comments.some(c=>!c.resolved))throw new HttpError(409,'请先处理未解决的审阅意见');
    review.approved=true;review.approvedAt=now();
  }else throw new HttpError(400,'不支持的审阅操作');
  const previous={review:job.review,history:job.reviewHistory,hadReview:Object.hasOwn(job,'review'),hadHistory:Object.hasOwn(job,'reviewHistory')};
  job.review=review;if(Object.hasOwn(draft,'reviewHistory'))job.reviewHistory=draft.reviewHistory;
  try {
    await engine.persist();
    await engine.record(job.id,'user',`review_${input.action}`,{version:review.versions.length,commentId:input.commentId||null,approved:review.approved});
  } catch(error) {
    if(previous.hadReview)job.review=previous.review;else delete job.review;
    if(previous.hadHistory)job.reviewHistory=previous.history;else delete job.reviewHistory;
    // The store uses atomic file replacement. Restore the old snapshot when
    // persistence or audit fails; a storage failure remains visible to caller.
    await engine.persist().catch(()=>{});throw error;
  }
  return {review};
}
