const SPECIALISTS=['frontend','backend'];
export function expandCoordination(job){
  if(job.coordinationVersion!==1||job.coordinationExpanded)return false;
  const plan=job.tasks.find(t=>t.id==='orchestrator');if(plan?.status!=='completed')return false;
  job.coordinationExpanded=true;
  if(!['website','code'].includes(job.workflow?.id||job.kind))return false;
  const assignments=Array.isArray(plan.result?.assignments)?plan.result.assignments:[];
  const selected=SPECIALISTS.filter(role=>assignments.some(a=>a.agentId===role&&typeof a.objective==='string'&&a.objective.trim()));
  const developer=job.tasks.find(t=>t.id==='developer');
  if(!selected.length||!developer||developer.status!=='blocked')return false;
  const stages=selected.map(role=>({id:role,agentId:role,title:role==='frontend'?'前端实现':'后端实现',deps:['context','architect'],status:'blocked',result:null,error:null}));
  job.tasks.splice(job.tasks.indexOf(developer),0,...stages);
  developer.deps=['context','architect',...selected];developer.title='总控整合交付';developer.coordinated=true;
  return true;
}
export function specialistInstructions(role){return `Implement only the ${role} assignment from the orchestrator. Follow the shared architecture, API contracts and file ownership. Avoid changing files owned by the other specialist. Return {summary,files:[{path,content}],notes:[],risks:[]}. Supply complete UTF-8 source files, not diffs, at most 12 files. No secrets, command execution or package downloads. Never modify .git, dependencies, build output or environment files. The coordinator will integrate your output and testing happens later. Do not claim any tests ran.`;}
export const planningInstruction='You are the coordinating lead. Break the request into actionable assignments with objectives. For website or code work, assign frontend and/or backend specialists only when relevant. Give shared files to developer for final integration. Do not ask the user to manage each worker. Available stages: context, architect, frontend, backend, developer (integration), tester, docs, regression, git. Return {summary,requirements:[{id,text,acceptance}],assignments:[{agentId,objective}],risks:[],deliverables:[]}. Make requirements measurable; report uncertainty honestly.';
