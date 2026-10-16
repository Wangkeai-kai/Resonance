import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
const sandbox={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(new URL('../dist/task-errors.js',import.meta.url),'utf8'),sandbox);
const messages=sandbox.module.exports;
test('existing saved JSON parser failures show a usable explanation after upgrading',()=>{
  const text=messages.describe("Expected ',' or ']' after array element in JSON at position 2408 (line 1 column 2409)");
  assert.match(text,/格式不正确/);assert.match(text,/保留/);assert.match(text,/继续/);
});
test('timeout explanations distinguish restarting unfinished work from restarting the task',()=>{
  assert.match(messages.describe('模型未在 90 秒内返回完整结果'),/换模型后继续/);
  assert.match(messages.describe('anything','model_invalid_structured_response'),/格式/);
  assert.equal(messages.describe('new unclassified failure'),'');
});
