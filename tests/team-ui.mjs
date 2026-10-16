import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const context={window:{},URL};
vm.runInNewContext(await fs.readFile(new URL('../dist/team-ui.js',import.meta.url),'utf8'),context);
const ui=context.window.TeamUI;
const providers=[{id:'lead',name:'统筹模型',model:'lead-v1',baseUrl:'https://example.test',hasKey:true},{id:'dev',name:'开发模型',model:'dev-v2',baseUrl:'http://localhost:11434'}];
test('team roles mirror effective gateway routing and do not hide invalid mapping',()=>{
  const config={providers,agentProviders:{orchestrator:'lead',developer:'dev'}};
  assert.equal(ui.resolve(config,'frontend').id,'dev');
  assert.equal(ui.resolve(config,'tester').id,'lead');
  assert.equal(ui.resolve({...config,agentProviders:{...config.agentProviders,frontend:'deleted'}},'frontend'),undefined);
  const html=ui.roster(config,'dev');
  assert.match(html,/主模型 · 总控/);assert.match(html,/dev-v2/);assert.match(html,/data-member-role="frontend"/);assert.match(html,/当前对话/);
});
test('task identities use recorded invocation, label snapshots, never use current models',()=>{
  const job={configSnapshot:{providers,agentProviders:{orchestrator:'lead',developer:'dev'}}};
  assert.equal(ui.assignment(job,{id:'developer',coordinated:true}).providerId,'lead');
  assert.match(ui.assignment(job,{id:'developer'}).source,/创建时配置/);
  const actual=ui.assignment(job,{id:'developer',modelAssignment:{providerId:'gone',name:'旧模型',model:'v0',role:'developer'}});
  assert.equal(actual.name,'旧模型');assert.equal(actual.source,'执行记录');
  assert.equal(ui.assignment({}, {id:'tester'}).name,'未记录模型');
});
test('model names and task identities are rendered as untrusted text',()=>{
  const hostile={id:'lead',name:'<img src=x onerror=alert(1)>',model:'<script>x</script>',baseUrl:'https://example.test'};
  const html=ui.roster({providers:[hostile]},'lead');
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
  const tasks=ui.taskTeam({tasks:[{id:'developer',status:'running',modelAssignment:{name:hostile.name,model:hostile.model}}]});
  assert.ok(!tasks.includes('<script>'));assert.ok(tasks.includes('执行记录'));
});

