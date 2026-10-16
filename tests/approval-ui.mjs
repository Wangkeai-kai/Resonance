import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const context={window:{},URL};
vm.runInNewContext(await fs.readFile(new URL('../dist/approval-ui.js',import.meta.url),'utf8'),context);
const ui=context.window.ApprovalUI;

test('approval summaries distinguish original-project changes from isolated work and do not imply GitHub upload',()=>{
  const save=ui.describe({type:'commit',details:{files:['index.html'],branch:'task/example'}});
  const merge=ui.describe({type:'merge',details:{targetBranch:'main',projectPath:'C:/sample/project'}});
  assert.match(save.effect,/原项目分支不变/);assert.match(save.effect,/不会上传 GitHub/);
  assert.match(merge.effect,/会修改原项目「project」/);assert.match(merge.effect,/main/);
  const revert=ui.describe({type:'rollback',details:{mainline:1}});
  assert.match(revert.effect,/原项目/);assert.match(revert.purpose,/保留原来的历史/);
  assert.match(ui.describe({type:'sandbox'}).decline,/当前任务会停止并标为失败/);
  assert.match(ui.describe({type:'sandbox',details:{dockerAvailable:false}}).note,/仍不可用时不会执行/);
});

test('MCP summary identifies actual destination and parameters without inventing read-only or reversible guarantees',()=>{
  const call={type:'mcp',serverName:'Project service',url:'https://example.org/mcp',tool:'update_file',arguments:{path:'README.md',content:'new text'}};
  const info=ui.describe(call),html=ui.body(call);
  assert.match(info.effect,/example\.org/);assert.match(info.effect,/无法保证操作只读或可以撤销/);
  assert.match(info.outcome,/不会自动重试/);assert.match(info.decline,/不发送执行请求/);
  assert.match(html,/README\.md/);assert.match(html,/new text/);assert.match(html,/完整参数/);
});

test('approval details are collapsed and escape untrusted paths, commands, arguments and request titles',()=>{
  const payload='<img src=x onerror=alert(1)>';
  for(const item of [{type:'merge',id:'x" onclick="x',title:payload,details:{projectPath:payload,commands:[{command:payload,args:[]}]}},{type:'mcp',arguments:{[payload]:payload},url:'http://localhost:3000/mcp'}]){
    const html=ui.body(item);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<details[^>]*\sopen[\s>]/);assert.doesNotMatch(html,/<details[^>]*"\s+onclick=/);
  }
  const unknown=ui.describe({type:'future-operation',title:'Unfamiliar operation'});
  assert.match(unknown.effect,/核对/);assert.doesNotMatch(unknown.effect,/只读|不变|隔离/);
});
