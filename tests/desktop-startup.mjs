import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';

const main=fileURLToPath(new URL('../desktop/main.cjs',import.meta.url));
const source=await readFile(main,'utf8');
function harness(){
  const userData=path.resolve('fixture-user-data'),sent=[],spawned=[],ipc=new Map();let nextCode='state_invalid';
  const app={setName(){},setPath(){},getVersion(){return '1.0.1';},getPath(){return userData;},getAppPath(){return path.dirname(path.dirname(main));},enableSandbox(){},requestSingleInstanceLock(){return false;},quit(){}};
  const spawn=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.connected=false;spawned.push(child);
    const code=nextCode;
    setImmediate(()=>{
      child.stderr.emit('data',Buffer.from('untrusted stack and secret-fixture-token\nGONGMING_STARTUP_'));
      child.emit('exit',1);
      setImmediate(()=>{child.stderr.emit('data',Buffer.from(`ERROR: ${JSON.stringify({code,message:'secret-fixture-token'})}`));child.stderr.emit('end');child.emit('close',1);});
    });
    return child;
  };
  const globals={Buffer,URL,Set,Promise,Date,AbortSignal,setTimeout,clearTimeout,process:{env:{},platform:'win32',execPath:'fixture-electron.exe',stdout:{write(){}},stderr:{write(){}}},__dirname:path.dirname(main),require(name){
    if(name==='./diagnostics.cjs')return {createDiagnostics:({directory})=>({directory,record:async()=>true,flush:async()=>{}})};
    if(name==='electron')return {app,BrowserWindow:function(){},dialog:{},ipcMain:{handle:(name,fn)=>ipc.set(name,fn),on(){}},shell:{},safeStorage:{}};
    if(name==='node:child_process')return {spawn};
    if(name==='node:fs')return {existsSync(){throw new Error('Unexpected disk probe');}};
    if(name==='node:fs/promises')return new Proxy({},{get(){return ()=>{throw new Error('Unexpected filesystem operation');};}});
    if(name==='node:net')return {};
    if(name==='node:path')return path;
    if(name==='node:url')return {pathToFileURL};
    throw new Error(`Unexpected dependency ${name}`);
  }};
  const context=vm.createContext(globals);
  vm.runInContext(source+`;globalThis.hooks={startupErrorReader,startupFailureInfo,waitUntilReady,startWorkspace,splashURL};`,context,{filename:main});
  const fakeWindow={isDestroyed:()=>false,webContents:{getURL:()=>context.hooks.splashURL,send:(_channel,state)=>sent.push({...state}),mainFrame:{url:context.hooks.splashURL}},loadFile:async()=>{}};
  context.fakeWindow=fakeWindow;
  vm.runInContext(`window=fakeWindow;choosePort=async()=>({port:47321,changed:false});backendEnvironment=async()=>({});`,context);
  return {...context.hooks,context,sent,spawned,ipc,userData,fakeWindow,setCode:code=>{nextCode=code;}};
}

test('only fixed startup marker codes are exposed, including split/no-newline markers',()=>{
  const h=harness(),codes=[],reader=h.startupErrorReader(code=>codes.push(code));
  reader.push('Error secret-fixture-token\nGONGMING_STARTUP_ERROR: {"code":"unknown-secret-code"}\n');
  reader.push('GONGMING_STARTUP_ERROR: not-json\n');
  reader.push('GONGMING_STARTUP_');reader.push('ERROR: {"code":"history_recovery_required","message":"secret-fixture-token"}');reader.finish();
  assert.deepEqual(codes,['history_recovery_required']);
  const info=h.startupFailureInfo(codes[0]);assert.ok(info.detail.includes(path.join(h.userData,'workspace')));assert.ok(info.detail.includes('备份'));assert.ok(info.detail.includes('不要删除'));
  assert.ok(!JSON.stringify(info).includes('secret-fixture-token'));
});
test('all categories have specific guidance and untrusted codes fall back safely',()=>{
  const h=harness(),titles=[];
  for(const code of ['workspace_in_use','history_recovery_required','state_invalid','chat_invalid','startup_failed']){
    const info=h.startupFailureInfo(code);assert.equal(info.code,code);titles.push(info.title);assert.ok(info.detail.includes('工作区位置：'));assert.ok(/不要删除|勿删除/.test(info.detail));
  }
  assert.equal(new Set(titles).size,5);
  const info=h.startupFailureInfo('secret-fixture-token');assert.equal(info.code,'startup_failed');assert.ok(!info.detail.includes('secret-fixture-token'));
  assert.ok(h.startupFailureInfo('startup_failed',true).title.includes('时间较长'));
});
test('exit-before-stderr-drain retains the structured startup error',async()=>{
  const h=harness();const record={exited:true};let drained;
  record.outputDone=new Promise(resolve=>drained=resolve);
  const result=h.waitUntilReady(record,'http://127.0.0.1:47321',0);
  record.startupCode='chat_invalid';drained();
  await assert.rejects(result,error=>error.startupCode==='chat_invalid');
});
test('mock backend startup and explicit retry show new error categories without stderr leakage',async()=>{
  const h=harness();
  assert.equal(await h.startWorkspace(),false);assert.equal(h.sent.at(-1).title,'工作记录暂时无法读取');
  assert.ok(!JSON.stringify(h.sent).includes('secret-fixture-token'));
  h.setCode('workspace_in_use');
  const event={sender:h.fakeWindow.webContents,senderFrame:h.fakeWindow.webContents.mainFrame};
  assert.equal(await h.ipc.get('desktop:retry')(event),false);
  assert.equal(h.sent.at(-1).title,'工作区正在使用');assert.equal(h.spawned.length,2);assert.ok(h.sent.at(-1).detail.includes('不要删除工作区或锁文件'));
  assert.equal(await h.ipc.get('desktop:retry')({sender:{},senderFrame:{url:'https://untrusted.example'}}),false);assert.equal(h.spawned.length,2);
});
