import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Engine} from '../lib/engine.mjs';
import {attachProviderVault} from '../lib/provider-vault.mjs';
test('keys survive restart only through protected vault, bound to endpoint and cleared on removal',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-key-vault-'));const saved=new Map();let count=0;
  const vault={seal:async text=>{const id=`cipher-${++count}`;saved.set(id,text);return id;},unseal:async id=>saved.get(id)};
  const engine=await new Engine(runtime).init();await attachProviderVault(engine,vault);
  await engine.config({providers:[{id:'one',type:'openai',baseUrl:'https://api.example.invalid/v1',model:'mock',apiKey:'private-fixture-api-key'}]});
  assert.equal(engine.credentialStorage,'encrypted');assert.ok(!(await fs.readFile(path.join(engine.runtime,'provider-credentials.json'),'utf8')).includes('private-fixture-api-key'));
  const next=await new Engine(runtime).init();await attachProviderVault(next,vault);assert.equal(next.keys.get('one'),'private-fixture-api-key');
  await next.config({providers:[{...next.state.config.providers[0],baseUrl:'https://another.invalid/v1'}]});assert.equal(next.keys.size,0);
  const final=await new Engine(runtime).init();await attachProviderVault(final,vault);assert.equal(final.keys.size,0);
});
test('encryption failures remain memory only without writing a plaintext fallback',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-key-vault-'));const engine=await new Engine(runtime).init();await attachProviderVault(engine,{seal:async()=>{throw new Error('vault unavailable');},unseal:async()=>{}});
  await engine.config({providers:[{id:'one',type:'openai',baseUrl:'https://api.example.invalid/v1',model:'mock',apiKey:'private-fixture'}]});assert.equal(engine.credentialStorage,'memory');assert.equal(engine.keys.get('one'),'private-fixture');await assert.rejects(fs.access(path.join(engine.runtime,'provider-credentials.json')));
});
test('a stale encrypted file cannot resurrect a cleared key after vault replacement fails',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'gongming-key-vault-'));const entries=new Map();let failed=false;
  const vault={seal:async text=>{if(failed)throw new Error('vault failed');entries.set('sealed',text);return 'sealed';},unseal:async id=>entries.get(id)};
  const engine=await new Engine(runtime).init();await attachProviderVault(engine,vault);
  await engine.config({providers:[{id:'one',type:'openai',baseUrl:'https://api.example.invalid/v1',model:'mock',apiKey:'stale-private-key'}]});
  failed=true;await engine.config({providers:[{...engine.state.config.providers[0],apiKey:''}]});assert.equal(engine.keys.size,0);
  const reloaded=await new Engine(runtime).init();await attachProviderVault(reloaded,vault);assert.equal(reloaded.keys.size,0);
});
