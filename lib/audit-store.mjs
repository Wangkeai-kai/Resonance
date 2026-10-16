import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {saveSnapshot} from './local-snapshot.mjs';

const MAX_LINE_BYTES = 1024 * 1024;
const parseRecord = line => {
  const item = JSON.parse(line);
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid audit record');
  return item;
};
async function regularFile(file) {
  const stat = await fs.promises.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('Invalid audit file');
  return stat;
}

// Reverse block reads preserve split UTF-8 characters. Callers serialize reads
// with rotation; the file size is fixed at the start of each read.
async function* reverseLines(file, onRead) {
  const stat = await regularFile(file);
  if (!stat) return;
  const handle = await fs.promises.open(file, 'r');
  try {
    let position = stat.size, pending = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const chunk = Buffer.alloc(length);
      const {bytesRead} = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new Error('Audit file changed while reading');
      onRead?.(bytesRead);
      const data = Buffer.concat([chunk, pending]);
      let end = data.length;
      for (let i = data.lastIndexOf(10); i >= 0; i = data.lastIndexOf(10, i - 1)) {
        if (end - i - 1 > MAX_LINE_BYTES) throw new Error('Audit record is too large');
        const line = data.subarray(i + 1, end).toString('utf8').trim();
        if (line) yield line;
        end = i;
        if (i === 0) break;
      }
      pending = data.subarray(0, end);
      if (pending.length > MAX_LINE_BYTES) throw new Error('Audit record is too large');
    }
    const first = pending.toString('utf8').trim();
    if (first) yield first;
  } finally { await handle.close(); }
}

export class AuditLog {
  constructor(file, {maxBytes = 8 * 1024 * 1024, maxArchives = 32, onRead} = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || !Number.isInteger(maxArchives) || maxArchives < 1 || maxArchives > 128) throw new Error('Invalid audit retention');
    this.file = file;
    this.metaFile = file + '.meta.json';
    this.maxBytes = maxBytes;
    this.maxArchives = maxArchives;
    this.onRead = onRead;
    this.ready = null;
  }
  async segments() {
    const prefix = path.basename(this.file) + '.';
    const names = await fs.promises.readdir(path.dirname(this.file)).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    return names.filter(name => name.startsWith(prefix) && /^\d{12}$/.test(name.slice(prefix.length)))
      .sort().map(name => path.join(path.dirname(this.file), name));
  }
  init() { return this.ready ||= this.initialize(); }
  async initialize() {
    if (await regularFile(this.metaFile)) {
      this.meta = JSON.parse(await fs.promises.readFile(this.metaFile, 'utf8'));
      if (this.meta.version !== 1 || typeof this.meta.hasJobs !== 'boolean' || !Number.isSafeInteger(this.meta.prunedSegments) || this.meta.prunedSegments < 0) throw new Error('Invalid audit metadata');
      return this;
    }
    this.meta = {version: 1, hasJobs: false, prunedSegments: 0};
    // Validate legacy records once. A separate durable marker preserves evidence
    // of historical jobs even after their segment expires under retention.
    let exists = false;
    for (const file of [...await this.segments(), this.file]) {
      if (!await regularFile(file)) continue;
      exists = true;
      const stream = fs.createReadStream(file, {encoding: 'utf8'});
      const lines = createInterface({input: stream, crlfDelay: Infinity});
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Audit record is too large');
          if (parseRecord(line).action === 'job_created') this.meta.hasJobs = true;
        }
      } finally { lines.close(); stream.destroy(); }
    }
    if (exists) await this.saveMeta();
    return this;
  }
  async saveMeta() {
    await saveSnapshot(this.metaFile, JSON.stringify(this.meta) + '\n');
  }
  async append(item) {
    await this.init();
    const line = JSON.stringify(item) + '\n';
    if (Buffer.byteLength(line) > Math.min(MAX_LINE_BYTES, this.maxBytes)) throw new Error('Audit record is too large');
    await fs.promises.mkdir(path.dirname(this.file), {recursive: true});
    if (item.action === 'job_created' && !this.meta.hasJobs) {
      this.meta.hasJobs = true;
      await this.saveMeta();
    } else if (!await regularFile(this.metaFile)) await this.saveMeta();
    const stat = await regularFile(this.file);
    if (stat?.size && stat.size + Buffer.byteLength(line) > this.maxBytes) {
      const segments = await this.segments();
      const next = Number(segments.at(-1)?.slice(-12) || 0) + 1;
      if (next >= 1e12) throw new Error('Audit segment sequence exhausted');
      await fs.promises.rename(this.file, this.file + '.' + String(next).padStart(12, '0'));
    }
    const archives = await this.segments();
    const expired = archives.slice(0, Math.max(0, archives.length - this.maxArchives));
    if (expired.length) {
      this.meta.prunedSegments += expired.length;
      await this.saveMeta();
      for (const file of expired) { await regularFile(file); await fs.promises.unlink(file); }
    }
    const handle = await fs.promises.open(this.file, 'a', 0o600);
    try { await handle.writeFile(line); await handle.sync(); }
    finally { await handle.close(); }
  }
  async read({limit = 1000, before, jobId} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid audit page size');
    await this.init();
    const items = [];
    let found = !before, hasMore = false;
    outer: for (const file of [this.file, ...(await this.segments()).reverse()]) {
      for await (const line of reverseLines(file, this.onRead)) {
        const item = parseRecord(line);
        if (!found) { if (item.id === before) found = true; continue; }
        if (jobId && item.jobId !== jobId) continue;
        if (items.length === limit) { hasMore = true; break outer; }
        items.push(item);
      }
    }
    if (!found) throw Object.assign(new Error('审计游标已过期或不存在，请重新读取最新记录。'), {status: 409});
    return {items: items.reverse(), hasJobs: this.meta.hasJobs, hasMore};
  }
}

export async function readAuditLog(file, options) {
  return new AuditLog(file).read(options);
}
