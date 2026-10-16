import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_SKILLS,SKILL_BUDGET,selectSkills,skillCatalog} from '../lib/builtin-skills.mjs';
import {Extensions} from '../lib/extensions.mjs';
import {Engine} from '../lib/engine.mjs';

test('builtins select by task and role without consuming custom slots', () => {
  const state={skills:[]};
  assert.equal(skillCatalog(state).length,8);
  const ppt=selectSkills(state,{kind:'ppt',role:'developer'});
  assert.deepEqual(ppt.map(s=>s.id),['builtin-presentation']);
  assert.ok(selectSkills(state,{kind:'ppt',role:'orchestrator'}).some(s=>s.id==='builtin-requirements'));
  assert.ok(!selectSkills(state,{kind:'code',role:'developer'}).some(s=>s.id==='builtin-presentation'));
  assert.equal(selectSkills(state,{brief:'帮我做一份 PPT',role:'chat'})[0].id,'builtin-presentation');
  assert.equal(selectSkills(state,{brief:'你好',role:'chat'})[0].id,'builtin-daily');
  assert.deepEqual(state,{skills:[]});
});

test('toggle survives serialization, preserves imported skills, and builtins are immutable', async () => {
  const original={id:'mine',content:'custom instructions',name:'My rules',source:'imported'};
  const engine={state:{skills:[original]},active:new Map(),queueConfig:fn=>fn(),persist:async()=>{},record:async()=>{},gateway:{redact:String}};
  const ext=await new Extensions(engine).init();
  await ext.skill({id:'builtin-presentation',action:'toggle',enabled:false});
  const restored=JSON.parse(JSON.stringify(engine.state));
  assert.ok(!selectSkills(restored,{kind:'ppt'}).some(s=>s.id==='builtin-presentation'));
  assert.equal(restored.skills.length,1);
  await assert.rejects(ext.skill({id:'builtin-presentation',action:'remove'}),/内置技能/);
  await assert.rejects(ext.skill({id:'builtin-presentation',name:'overwrite',content:'bad'}),/内置技能/);
  assert.equal(BUILTIN_SKILLS[0].name,'PPT 内容与版式');
  await ext.skill({id:'builtin-presentation',action:'toggle',enabled:true});
  assert.ok(selectSkills(engine.state,{kind:'ppt'}).some(s=>s.id==='builtin-presentation'));
  assert.equal(engine.state.skills[0],original);
});

test('skills remain bounded even with many large custom instructions', () => {
  const state={skills:Array.from({length:30},(_,i)=>({id:String(i),name:'rule',content:'x'.repeat(24000),source:'imported'}))};
  const selected=selectSkills(state,{kind:'code',role:'developer'});
  assert.equal(selected.filter(s=>s.source==='imported').length,2);
  assert.ok(selected.reduce((n,s)=>n+s.content.length,0)<=SKILL_BUDGET);
  assert.ok(selected.some(s=>s.id==='builtin-code'));
});

test('real engine request receives relevant instructions and records references only', async () => {
  const engine=new Engine('.');let captured;
  engine.gateway.complete=async(job,role,instructions,input)=>{captured=input;return {summary:'test'};};
  const job={id:'job-fixture',kind:'ppt',brief:'产品说明',workflow:{id:'ppt',values:{slideCount:'8'}}},task={id:'developer'};
  await engine.model(job,task,'Create the requested files',{});
  assert.match(captured.skills[0].content,/每页围绕一个重点/);
  assert.ok(!captured.skills.some(s=>s.id==='builtin-code'));
  assert.equal(task.appliedSkills[0].id,'builtin-presentation');
  assert.ok(!Object.hasOwn(task.appliedSkills[0],'content'));
});
