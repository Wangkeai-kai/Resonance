import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createDiagnostics}=createRequire(import.meta.url)('../desktop/diagnostics.cjs');
async function fixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-log-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,log:createDiagnostics({directory:path.join(root,'logs'),version:'1.0.1',platform:'win32',...options})};
}
test('diagnostics persists event codes without stderr, paths, secrets or arbitrary messages', async t => {
  const {root,log}=await fixture(t);
  await log.record('startup_failed',{code:'state_invalid',timedOut:false,message:'secret-fixture-token',stderr:'private prompt',path:'private-directory'});
  await log.record('backend_exit',{code:1,signal:'SIGTERM',expected:false});
  assert.equal(await log.record('secret-fixture-token',{message:'private prompt'}),false);
  const text=await fs.readFile(path.join(root,'logs/desktop.jsonl'),'utf8'),events=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events.length,2);assert.equal(events[0].code,'state_invalid');assert.equal(events[1].signal,'SIGTERM');assert.equal(events[0].version,'1.0.1');assert.ok(events.every(e=>Number.isFinite(Date.parse(e.at))));
  for(const value of ['secret-fixture-token','private prompt','private-directory'])assert.ok(!text.includes(value));
});
test('diagnostic rotation bounds disk usage and retains valid complete records', async t => {
  const {root,log}=await fixture(t,{maxBytes:512,backups:2});
  await Promise.all(Array.from({length:100},(_,attempt)=>log.record('backend_start',{attempt})));await log.flush();
  const files=await fs.readdir(path.join(root,'logs'));assert.ok(files.length<=3);
  for(const file of files){const text=await fs.readFile(path.join(root,'logs',file),'utf8');assert.ok(Buffer.byteLength(text)<=512);for(const line of text.trim().split('\n'))assert.equal(JSON.parse(line).event,'backend_start');}
  const last=JSON.parse((await fs.readFile(path.join(root,'logs/desktop.jsonl'),'utf8')).trim().split('\n').at(-1));assert.equal(last.attempt,99);
});
test('unknown diagnostic values are reduced to fixed categories', async t => {
  const {root,log}=await fixture(t);
  await log.record('backend_spawn_failed',{code:'secret-fixture-token'});await log.record('renderer_exit',{reason:'private-detail',code:7});
  const lines=(await fs.readFile(path.join(root,'logs/desktop.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(lines[0].code,'unknown');assert.equal(lines[1].reason,'unknown');assert.equal(lines[1].code,7);
});
test('unwritable diagnostics cannot break startup and logging can recover', async t => {
  const {root,log}=await fixture(t);await fs.writeFile(path.join(root,'logs'),'obstruction');
  assert.equal(await log.record('desktop_start'),false);await fs.unlink(path.join(root,'logs'));assert.equal(await log.record('desktop_start'),true);
});
