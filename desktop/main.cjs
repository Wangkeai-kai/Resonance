'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDiagnostics } = require('./diagnostics.cjs');

app.setName('Gongming');
app.setPath('userData', process.env.GONGMING_DESKTOP_USER_DATA
  ? path.resolve(process.env.GONGMING_DESKTOP_USER_DATA)
  : path.join(app.getPath('appData'), 'Gongming'));
app.enableSandbox();
const diagnostics = createDiagnostics({directory:path.join(app.getPath('userData'), 'logs'), version:app.getVersion(), platform:process.platform});

const DEFAULT_PORT = 47321;
const SMOKE = process.env.GONGMING_DESKTOP_SMOKE === '1';
const splashPath = path.join(__dirname, 'splash.html');
const splashURL = pathToFileURL(splashPath).href;
let window;
let backend;
let origin;
let starting;
let quitting = false;
let generation = 0;
let exitCode = 0;
let smokeReport = { state: 'starting' };
let splashState = { state: 'loading', title: '正在打开工作台', detail: '连接本地工作区，你的任务和作品都在这里。' };

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const STARTUP_CODES = new Set(['workspace_in_use', 'history_recovery_required', 'state_invalid', 'chat_invalid', 'startup_failed']);
function startupErrorReader(onCode) {
  let pending = '';
  const consume = line => {
    const match = line.match(/^GONGMING_STARTUP_ERROR:\s*(\{[^\r\n]*\})\s*$/);
    if (!match) return;
    try {
      const value = JSON.parse(match[1]);
      if (value && STARTUP_CODES.has(value.code)) onCode(value.code);
    } catch { /* Arbitrary stderr and malformed markers never reach the UI. */ }
  };
  return {
    push(chunk) {
      // Keep only a bounded temporary tail; never save or display stderr text.
      pending = (pending + chunk.toString()).slice(-4096);
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      lines.forEach(consume);
    },
    finish() { consume(pending); pending = ''; },
  };
}
function startupFailureInfo(code, timedOut = false) {
  const descriptions = {
    workspace_in_use: ['工作区正在使用', '另一个Resonance服务正在使用此工作区。请先关闭另一个实例，再重新连接。请不要删除工作区或锁文件。'],
    history_recovery_required: ['本地历史记录需要恢复', '发现已有历史文件，但当前记录不完整。请先备份整个工作区，再从有效备份恢复或联系维护者处理。请不要删除原文件或用空记录覆盖。'],
    state_invalid: ['工作记录暂时无法读取', '工作记录的格式损坏或版本不兼容。请先备份整个工作区，再迁移或恢复记录。请不要删除原文件。'],
    chat_invalid: ['对话记录暂时无法读取', '对话记录的格式损坏或版本不兼容。请先备份整个工作区，再迁移或恢复对话。请不要删除原文件。'],
    startup_failed: ['暂时没有打开工作台', '本地服务未能启动。请确认软件目录完整后重试；如果仍然失败，请先备份工作区并联系维护者，勿删除工作记录。'],
  };
  const known = STARTUP_CODES.has(code) ? code : 'startup_failed';
  const [title, description] = timedOut && known === 'startup_failed'
    ? ['工作台启动时间较长', '本地服务尚未就绪，可以稍后重试。反复超时时，请先备份整个工作区并联系维护者，勿删除工作记录。']
    : descriptions[known];
  return { code: known, title, detail: `${description}\n工作区位置：${path.join(app.getPath('userData'), 'workspace')}\n诊断日志：${diagnostics.directory}` };
}
const isSplash = url => {
  try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; return parsed.href === splashURL; }
  catch { return false; }
};
const isWorkspace = url => {
  try { const parsed = new URL(url); return origin && parsed.origin === origin && !parsed.username && !parsed.password; }
  catch { return false; }
};
const isTrustedSender = event => Boolean(window && !window.isDestroyed()
  && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  && (isSplash(event.senderFrame.url) || isWorkspace(event.senderFrame.url)));

ipcMain.handle('desktop:api-token', event => {
  if (!isTrustedSender(event) || !isWorkspace(event.senderFrame.url) || backend?.exited) return null;
  return backend?.apiToken || null;
});

async function showSplash(state, title, detail) {
  splashState = { state, title, detail };
  if (!window || window.isDestroyed() || quitting) return;
  if (!isSplash(window.webContents.getURL())) await window.loadFile(splashPath);
  if (!window.isDestroyed()) window.webContents.send('desktop:state', splashState);
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Resonance · 工作台', width: 1480, height: 980, minWidth: 1000, minHeight: 700,
    backgroundColor: '#edf1f6', show: false, autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: {color:'#edf1f6',symbolColor:'#45616c',height:36},
    icon: path.join(app.getAppPath(), 'assets', 'gongming.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  window.setMenu(null);
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.record('renderer_exit', {reason:details.reason, code:details.exitCode});
    if (!quitting) showSplash('error', '界面意外关闭', '已记录故障类别。可以重新打开工作台，或查看诊断日志；已保存的工作记录仍保留。').catch(() => {});
  });
  window.on('unresponsive', () => diagnostics.record('renderer_unresponsive'));
  window.once('ready-to-show', () => { if (!SMOKE && !window.isDestroyed()) window.show(); });
  window.on('page-title-updated', event => { event.preventDefault(); window.setTitle('Resonance · 工作台'); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, legacyURL) => {
    // External links are handled only after an explicit, trusted click in preload.
    if (!isWorkspace(event.url || legacyURL)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, legacyURL) => {
    if (!isWorkspace(event.url || legacyURL)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', event => {
    // Electron 44 carries navigation details on the event itself.
    if (event.isMainFrame) {
      if (!isWorkspace(event.url)) event.preventDefault();
      return;
    }
    // The artifact preview uses sandboxed srcdoc and blob frames.
    const url = event.url;
    if (!(isWorkspace(url) || url === 'about:blank' || url === 'about:srcdoc'
      || (origin && url.startsWith(`blob:${origin}/`)))) event.preventDefault();
  });
  window.webContents.on('did-finish-load', () => {
    if (isSplash(window.webContents.getURL())) window.webContents.send('desktop:state', splashState);
  });
  window.webContents.on('render-process-gone', () => {
    if (!quitting) showSplash('error', '工作台需要重新打开', '界面意外停止了。重新打开即可继续，已保存的工作仍在本地。').catch(() => {});
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  return window.loadFile(splashPath);
}

async function reservePort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      const selected = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

async function choosePort() {
  const preferencesPath = path.join(app.getPath('userData'), 'desktop.json');
  let preferred = DEFAULT_PORT;
  try {
    const saved = JSON.parse(await fs.readFile(preferencesPath, 'utf8'));
    if (validPort(saved.port)) preferred = saved.port;
  } catch { /* First launch or invalid preferences: use the stable default. */ }
  let port;
  try { port = await reservePort(preferred); }
  catch { port = await reservePort(0); }
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(preferencesPath, `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o600 });
  return { port, changed: port !== preferred };
}

async function backendEnvironment() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1',
    GONGMING_DESKTOP_VAULT: safeStorage.isEncryptionAvailable()?'1':'0',
    GONGMING_DATA_DIR: path.join(app.getPath('userData'), 'workspace') };
  const available = await new Promise(resolve => {
    const probe = spawn('git', ['--version'], { env, windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { probe.kill(); resolve(false); }, 2500);
    probe.once('error', () => { clearTimeout(timer); resolve(false); });
    probe.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
  if (available || process.platform !== 'win32') return env;
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd'),
  ];
  const found = candidates.find(directory => directory && existsSync(path.join(directory, 'git.exe')));
  if (found) {
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
    env[key] = `${found}${path.delimiter}${env[key] || ''}`;
  }
  return env;
}

async function waitUntilReady(record, expectedOrigin, attempt) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !quitting && generation === attempt) {
    if (record.startupCode) throw Object.assign(new Error('local-server-stopped'), { startupCode: record.startupCode });
    if (record.error || record.exited) {
      // Node can emit exit before the last stderr chunk. Drain it before choosing
      // the safe error category, so retry shows the actual startup condition.
      if (record.outputDone) await Promise.race([record.outputDone, delay(250)]);
      throw Object.assign(new Error('local-server-stopped'), { startupCode: record.startupCode || 'startup_failed' });
    }
    // A successful HTTP response from another process cannot count as our backend.
    if (record.listening && record.apiToken) {
      try {
        const response = await fetch(`${expectedOrigin}/api/status`, {
          signal: AbortSignal.timeout(1200), redirect: 'error', headers: {Authorization: `Bearer ${record.apiToken}`},
        });
        if (response.ok) {
          const data = await response.json();
          if (data && typeof data === 'object' && data.capabilities && !record.exited) return data;
        }
      } catch { /* Startup may still be settling; retry until the bounded deadline. */ }
    }
    await delay(150);
  }
  throw new Error(quitting || generation !== attempt ? 'cancelled' : 'local-server-timeout');
}

async function terminateOwnedProcess(record) {
  if (!record || record.stopping) return record?.stopping;
  record.stopping = (async () => {
    record.state = 'stopping';
    if (record.exited) return;
    try {
      if (record.child.connected) record.child.send({ type: 'gongming:shutdown' }, () => {});
    } catch { /* Fall back to terminating the owned process tree. */ }
    await Promise.race([record.done, delay(1800)]);
    if (record.exited) return;
    if (process.platform === 'win32' && Number.isInteger(record.child.pid)) {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], {
          windowsHide: true, shell: false, stdio: 'ignore',
        });
        killer.once('error', resolve);
        killer.once('exit', resolve);
      });
    } else {
      try { record.child.kill('SIGTERM'); } catch { /* The process already exited. */ }
      await Promise.race([record.done, delay(700)]);
      if (!record.exited) { try { record.child.kill('SIGKILL'); } catch { /* Already exited. */ } }
    }
    await Promise.race([record.done, delay(1000)]);
  })();
  return record.stopping;
}

async function startWorkspace() {
  if (starting || quitting) return starting;
  const attempt = ++generation;
  const startedAt = Date.now();
  starting = (async () => {
    let startupRecord;
    try {
      await showSplash('loading', '正在打开工作台', '连接本地工作区，你的任务和作品都在这里。');
      await terminateOwnedProcess(backend);
      if (quitting || generation !== attempt) return;
      const { port, changed } = await choosePort();
      const env = await backendEnvironment();
      if (quitting || generation !== attempt) return;
      const nextOrigin = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, [path.join(app.getAppPath(), 'server.mjs'), '--port', String(port)], {
        cwd: app.getAppPath(), windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env,
      });
      const record = { child, state: 'starting', exited: false, error: false, listening: false };
      diagnostics.record('backend_start', {attempt});
      startupRecord = record;
      record.done = new Promise(resolve => { record.resolve = resolve; });
      record.outputDone = new Promise(resolve => child.once('close', resolve));
      backend = record;
      let browserTestBusy=false;
      child.on('message', message => {
        if(message?.type==='gongming:ready' && /^[a-f0-9]{64}$/.test(message.token||'')) {
          record.apiToken=message.token;record.listening=true;return;
        }
        if(message?.type==='gongming:browser-check'&&typeof message.id==='string'&&message.id.length<=100&&child.connected){
          if(browserTestBusy){child.send({type:'gongming:browser-result',id:message.id,error:true});return;}
          browserTestBusy=true;
          require('./browser-check.cjs').runBrowserCheck(message.html,message.steps).then(result=>{
            if(child.connected)child.send({type:'gongming:browser-result',id:message.id,result});
          }).catch(()=>{
            diagnostics.record('browser_check_failed',{});
            if(child.connected)child.send({type:'gongming:browser-result',id:message.id,error:true});
          }).finally(()=>{browserTestBusy=false;});
          return;
        }
        if(message?.type!=='gongming:vault'||typeof message.id!=='string'||!child.connected)return;
        try {
          if(!safeStorage.isEncryptionAvailable()||typeof message.value!=='string'||message.value.length>200000)throw new Error('vault-unavailable');
          let value;
          if(message.operation==='seal')value=safeStorage.encryptString(message.value).toString('base64');
          else if(message.operation==='unseal')value=safeStorage.decryptString(Buffer.from(message.value,'base64'));
          else throw new Error('invalid-operation');
          child.send({type:'gongming:vault-result',id:message.id,value});
        }catch{child.send({type:'gongming:vault-result',id:message.id,error:true});}
      });
      let outputTail = '';
      child.stdout.on('data', chunk => {
        // Use only the listening marker; never persist command output or credentials.
        outputTail = (outputTail + chunk.toString()).slice(-4096);
        if (outputTail.includes(`Review FM local collaboration: ${nextOrigin}`)) record.listening = true;
      });
      const startupReader = startupErrorReader(code => {
        if (!record.startupCode || record.startupCode === 'startup_failed') record.startupCode = code;
      });
      child.stderr.on('data', chunk => startupReader.push(chunk));
      child.stderr.once('end', () => startupReader.finish());
      child.once('error', error => { diagnostics.record('backend_spawn_failed', {code:error.code}); record.error = true; record.exited = true; record.resolve(); });
      child.once('exit', (code, signal) => {
        diagnostics.record('backend_exit', {code, signal, expected:quitting || record.state === 'stopping'});
        const wasRunning = record.state === 'running';
        record.exited = true;
        record.resolve();
        if (backend === record && wasRunning && !quitting) {
          origin = undefined;
          showSplash('error', '本地服务已断开', '已保存的任务仍在本地。重新连接后，可在任务中继续未完成的工作。').catch(() => {});
        }
      });
      const status = await waitUntilReady(record, nextOrigin, attempt);
      if (quitting || generation !== attempt || window.isDestroyed()) return;
      origin = nextOrigin;
      await window.loadURL(`${origin}/`);
      record.state = 'running';
      diagnostics.record('backend_ready', {elapsedMs:Date.now() - startedAt});
      if (!SMOKE) window.show();
      if (SMOKE) {
        const rendererStatus = await window.webContents.executeJavaScript("fetch('/api/status').then(response=>response.status)");
        if (rendererStatus !== 200) throw new Error('renderer-session-failed');
        smokeReport = { state: 'ready', rendererStatus, url: `${origin}/`, title: window.getTitle(), backendPid: child.pid, capabilities: status.capabilities };
        process.stdout.write(`${JSON.stringify({ event: 'desktop-ready', ...smokeReport })}\n`);
        setTimeout(() => app.quit(), 5000).unref();
      } else if (changed) {
        await dialog.showMessageBox(window, {
          type: 'info', title: 'Resonance', message: '工作台已切换到新的本地连接',
          detail: '原来的连接端口被其他程序占用，Resonance已自动选择可用端口。任务和模型配置仍保留；部分界面本地记录可能暂时不可见。',
          buttons: ['继续使用'], defaultId: 0, noLink: true,
        });
      }
      return true;
    } catch (error) {
      await terminateOwnedProcess(backend);
      origin = undefined;
      if (!quitting && generation === attempt) {
        const failure = startupFailureInfo(startupRecord?.startupCode || error.startupCode, error.message === 'local-server-timeout');
        diagnostics.record('startup_failed', {code:failure.code, timedOut:error.message === 'local-server-timeout'});
        await showSplash('error', failure.title, failure.detail);
        if (SMOKE) { smokeReport = { state: 'failed', reason: failure.code }; process.stderr.write(`Gongming desktop smoke failed: ${failure.code}.\n`); exitCode = 1; app.quit(); }
      }
      return false;
    } finally { starting = undefined; }
  })();
  return starting;
}

ipcMain.handle('desktop:retry', async event => {
  if (!isTrustedSender(event) || !isSplash(event.senderFrame.url)) return false;
  return (await startWorkspace()) === true;
});
ipcMain.handle('desktop:diagnostics', async event => {
  if (!isTrustedSender(event)) return false;
  await diagnostics.flush();
  await fs.mkdir(diagnostics.directory, {recursive:true, mode:0o700});
  return (await shell.openPath(diagnostics.directory)) === '';
});
let dictationBusy = false;
ipcMain.on('desktop:theme', (event, mode) => {
  if (!isTrustedSender(event) || !isWorkspace(event.senderFrame.url) || !['light','dark'].includes(mode)) return;
  window.setTitleBarOverlay({color:mode==='dark'?'#1b2230':'#edf1f6',symbolColor:mode==='dark'?'#d3e4ed':'#45616c',height:36});
});
ipcMain.handle('desktop:dictation', async event => {
  if (!isTrustedSender(event) || !isWorkspace(event.senderFrame.url) || process.platform !== 'win32'
      || !window.isFocused() || dictationBusy) return false;
  dictationBusy = true;
  try {
    return await new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'dictation.ps1'),'-ExpectedProcess',String(process.pid)], {windowsHide:true,shell:false,stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill();resolve(false);},10000);
      child.once('error',()=>{clearTimeout(timer);resolve(false);});
      child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});
    });
  } finally { dictationBusy=false; }
});
ipcMain.on('desktop:external-link', (event, url) => {
  if (!isTrustedSender(event) || typeof url !== 'string' || url.length > 8192) return;
  try {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || isWorkspace(url)) return;
    // Loopback services and local files are never navigation targets outside this app.
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(target.hostname)
      || target.hostname.endsWith('.localhost')) return;
    shell.openExternal(target.href).catch(() => {});
  } catch { /* Invalid external URL. */ }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    generation += 1;
    terminateOwnedProcess(backend).then(async () => {
      await diagnostics.record('desktop_exit');
      if (SMOKE) {
        smokeReport.backendStopped = !backend || backend.exited;
        if (!smokeReport.backendStopped || smokeReport.state !== 'ready') exitCode = 1;
        smokeReport.exitCode = exitCode;
        await fs.mkdir(app.getPath('userData'), { recursive: true });
        await fs.writeFile(path.join(app.getPath('userData'), 'desktop-smoke.json'), `${JSON.stringify(smokeReport, null, 2)}\n`);
      }
    }).catch(() => { exitCode = 1; }).finally(() => { process.exitCode = exitCode; app.quit(); });
  });
  app.whenReady().then(async () => { await diagnostics.record('desktop_start'); await createWindow(); await startWorkspace(); }).catch(() => {
    diagnostics.record('startup_failed', {code:'startup_failed'});
    exitCode = 1;
    if (!SMOKE) dialog.showErrorBox('Resonance未能打开', '软件启动失败。请确认软件目录完整，然后重新打开。');
    app.quit();
  });
}
