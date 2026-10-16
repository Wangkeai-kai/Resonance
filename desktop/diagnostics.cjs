'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Persist fixed event codes and numeric metadata only. Never accept stderr,
// request bodies, credentials, account names, paths or arbitrary error messages.
function eventDetails(event, input) {
  const number = key => Number.isSafeInteger(input[key]) ? input[key] : undefined;
  const pick = (key, values) => values.includes(input[key]) ? input[key] : undefined;
  switch (event) {
    case 'desktop_start': case 'desktop_exit': case 'renderer_unresponsive': case 'browser_check_failed': return {};
    case 'backend_start': return {attempt:number('attempt')};
    case 'backend_ready': return {elapsedMs:number('elapsedMs')};
    case 'backend_exit': return {code:number('code'), signal:pick('signal',['SIGTERM','SIGKILL','SIGINT','SIGABRT']), expected:input.expected === true};
    case 'backend_spawn_failed': return {code:pick('code',['ENOENT','EACCES','EPERM','EADDRINUSE']) || 'unknown'};
    case 'startup_failed': return {code:pick('code',['workspace_in_use','history_recovery_required','state_invalid','chat_invalid','startup_failed']) || 'startup_failed', timedOut:input.timedOut === true};
    case 'renderer_exit': return {reason:pick('reason',['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure']) || 'unknown', code:number('code')};
    default: return null;
  }
}

function createDiagnostics({directory, version, platform, maxBytes = 256 * 1024, backups = 3}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isInteger(backups) || backups < 1 || backups > 10) throw new TypeError('Invalid log limits');
  const file = path.join(directory, 'desktop.jsonl');
  const metadata = {version:/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : 'unknown', platform:['win32','darwin','linux'].includes(platform) ? platform : 'unknown'};
  let chain = Promise.resolve();
  function record(event, input = {}) {
    const details = eventDetails(event, input);
    if (details === null) return Promise.resolve(false);
    const line = JSON.stringify({at:new Date().toISOString(), ...metadata, event, ...details}) + '\n';
    chain = chain.then(async () => {
      await fs.mkdir(directory, {recursive:true, mode:0o700});
      const info = await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info && info.size + Buffer.byteLength(line) > maxBytes) {
        for (let i = backups; i >= 1; i--) {
          const from = i === 1 ? file : `${file}.${i - 1}`;
          // unlink only the fixed owned destination; never recursively touch data.
          await fs.unlink(`${file}.${i}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.rename(from, `${file}.${i}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      await fs.appendFile(file, line, {mode:0o600});
      return true;
    }).catch(() => false);
    return chain;
  }
  return {record, flush:() => chain, directory};
}
module.exports = {createDiagnostics};
