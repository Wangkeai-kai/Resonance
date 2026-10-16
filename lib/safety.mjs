import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const id = prefix => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
export const now = () => new Date().toISOString();
export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || message; } }
export function isWithin(root, target) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export const blockedSegment = segment => /^(?:\.git|\.runtime|node_modules|\.aws|\.ssh|\.gnupg|\.codex|\.agents|\.venv|venv|dist|build|coverage|vendor)$/i.test(segment);
export const secretFile = name => /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
export async function safePath(root, relative, { writing = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Invalid relative file path');
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '..' || p === '.' || /[\x00-\x1f:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p) || blockedSegment(p) || secretFile(p))) throw new Error(`Restricted file path: ${relative}`);
  const absolute = path.resolve(root, ...parts);
  if (!isWithin(root, absolute)) throw new Error('File escapes workspace');
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (stat?.isSymbolicLink()) throw new Error(`Symbolic links are not permitted: ${relative}`);
    if (stat?.isFile() && stat.nlink > 1) throw new Error(`Hard-linked files are not permitted: ${relative}`);
    if (stat && writing && current === absolute && !stat.isFile()) throw new Error('Expected a regular file');
  }
  return absolute;
}
export async function readContext(root, limits = {}) {
  const files = []; const skipped = []; let total = 0;
  const maxFiles = limits.maxFiles || 100, maxBytes = limits.maxBytes || 180000, maxFile = limits.maxFile || 18000;
  const walk = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (blockedSegment(entry.name) || secretFile(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute).replaceAll('\\','/');
      if (entry.isDirectory()) { if (files.length < maxFiles && total < maxBytes) await walk(absolute); continue; }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|py|java|css|html|sql|go|rs|cs|xml|sh|vue|svelte|rb|php|c|h|cpp|svg)$/i.test(entry.name)) continue;
      const stat = await fs.stat(absolute);
      if (stat.nlink > 1) { skipped.push(relative); continue; }
      if (stat.size > maxFile || total + stat.size > maxBytes || files.length >= maxFiles) { skipped.push(relative); continue; }
      const content = await fs.readFile(absolute, 'utf8'); if (content.includes('\0')) continue;
      files.push({ path: relative, content, hash: hash(content), bytes: stat.size }); total += stat.size;
    }
  };
  await walk(root); return { files, skipped, totalBytes: total, truncated: skipped.length > 0 || files.length >= maxFiles, limits: { maxFiles, maxBytes, maxFile } };
}
export function runCommand(command, args, { cwd, timeout = 30000, maxBytes = 1000000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > maxBytes) { child.kill(); return; } if (target === 'out') stdout += chunk.toString(); else stderr += chunk.toString(); };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, outputTruncated: bytes > maxBytes }); });
  });
}
export function parseJSON(text) {
  const clean = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(clean); } catch { const start = clean.indexOf('{'), end = clean.lastIndexOf('}'); if (start >= 0 && end > start) return JSON.parse(clean.slice(start,end+1)); throw new Error('Model did not return valid JSON'); }
}
export function validateProvider(provider) {
  if (!provider || !/^[a-zA-Z0-9_-]{1,64}$/.test(provider.id || '')) throw new HttpError(400, 'Provider id must contain 1–64 letters, numbers, underscores or hyphens');
  let url; try { url = new URL(provider.baseUrl); } catch { throw new HttpError(400,'Invalid model base URL'); }
  if (url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol)) throw new HttpError(400,'Model URL must not contain credentials, query or fragment');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new HttpError(400,'Remote models require HTTPS');
  if (!provider.model || typeof provider.model !== 'string' || provider.model.length > 160) throw new HttpError(400,'A model id is required');
  if (!['openai','anthropic','chatgpt-plan'].includes(provider.type || 'openai')) throw new HttpError(400,'Unsupported provider type');
  if(provider.type==='chatgpt-plan'&&(url.href.replace(/\/$/,'')!=='https://api.openai.com/v1'||typeof provider.accountId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(provider.accountId)))throw new HttpError(400,'ChatGPT 连接必须使用已授权账号与官方地址');
  if(provider.thinkingMode!==undefined&&!['disabled','enabled'].includes(provider.thinkingMode))throw new HttpError(400,'推理模式需为 disabled 或 enabled');
  return { ...(provider.type==='chatgpt-plan'?{accountId:provider.accountId}:{}),...(provider.thinkingMode?{thinkingMode:provider.thinkingMode}:{}),id:provider.id,name:String(provider.name || provider.id).slice(0,80),type:provider.type || 'openai',baseUrl:url.href.replace(/\/$/,''),model:provider.model };
}
