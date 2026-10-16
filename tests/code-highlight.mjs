import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const context={module:{exports:{}}};vm.runInNewContext(await fs.readFile(new URL('../dist/code-highlight.js',import.meta.url),'utf8'),context);const {highlight}=context.module.exports;
test('local code highlighting escapes all source before adding fixed token markup',()=>{
 const result=highlight('const token = "<img src=x onerror=alert(1)>"; // comment','javascript');assert.match(result,/code-keyword/);assert.match(result,/code-string/);assert.match(result,/code-comment/);assert.ok(!result.includes('<img'));assert.match(result,/&lt;img/);
});
test('unknown languages and large source have bounded plain-text fallbacks',()=>{
 assert.equal(highlight('<script>','unknown'),'&lt;script&gt;');const huge='const '.repeat(13000);assert.ok(!highlight(huge,'javascript').includes('<span'));
});
