import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['package.json', 'server.mjs', 'README.md', 'ARCHITECTURE.md', 'GITHUB-PUBLISH.md', 'TESTING.md', 'DESKTOP.md', '启动共鸣.cmd', '.gitignore'];
const optional = ['docs/SKILLS.md', 'docs/examples/resonance-presentation.json', 'docs/screenshots/resonance-skills.png', '启动Resonance.cmd', 'docs/FRONTEND-OPTIMIZATION-CHECKLIST.md', 'docs/OPTIMIZATION-STATUS.md', 'docs/WORKFLOW-IMPORT.md', 'docs/INSTALL.md', 'docs/examples/website.gmflow.json', '.github/workflows/release.yml', 'docs/screenshots/resonance-chat.png', 'docs/screenshots/resonance-workflows.png', 'docs/screenshots/resonance-settings.png', 'docs/screenshots/resonance-task-recovery.png', 'docs/screenshots/resonance-artifacts.png', 'package-lock.json', 'LICENSE', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/USAGE.md', 'docs/GITHUB-ABOUT.md', 'docs/ENGINEERING-REVIEW.md', ...['chat-light', 'chat-dark', 'approval', 'team-task', 'group-chat', 'group-chat-dark', 'direct-chat', 'model-streaming', 'task-models', 'conversation-menu'].map(name => `docs/screenshots/${name}.png`)];
const folders = { dist: /\.(?:js|css|html|svg|png|webp|jpe?g)$/i, lib: /\.mjs$/, desktop: /\.(?:cjs|js|ps1|cmd|html|css|svg|png|ico)$/i, scripts: /\.mjs$/, assets: /\.(?:svg|png|ico)$/i };
const privateName = name => /^(?:\.runtime|\.openai|\.git|\.env(?:\..*)?|node_modules|work|test-results|playwright-report|coverage|state(?:\.previous)?\.json|chats(?:\.previous)?\.json|audit\.jsonl|.*credentials.*)$/i.test(name);
const inside = (root, destination) => { const rel = path.relative(root, destination); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const exists = async file => Boolean(await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }));

// The allowlist is independent from .gitignore; fixture subdirectories are never traversed.
export async function collectSourceEntries(project) {
  const files = [];
  const add = async relative => {
    let cursor = project;
    for (const part of relative.split(/[\\/]/)) { cursor = path.join(cursor, part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Source symlinks are not packaged: ${relative}`); }
    const info = await fs.lstat(path.join(project, relative));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular source file: ${relative}`);
    files.push(relative.split(path.sep).join('/'));
  };
  for (const relative of required) await add(relative);
  for (const relative of optional) if (await exists(path.join(project, relative))) await add(relative);
  const walk = async (relative, extension) => {
    const info = await fs.lstat(path.join(project, relative));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a regular source directory: ${relative}`);
    for (const entry of await fs.readdir(path.join(project, relative), { withFileTypes: true })) {
      if (privateName(entry.name)) continue;
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not packaged: ${child}`);
      if (entry.isDirectory()) await walk(child, extension);
      else if (entry.isFile() && extension.test(entry.name)) await add(child);
    }
  };
  for (const [folder, extension] of Object.entries(folders)) await walk(folder, extension);
  const tests = path.join(project, 'tests');
  if ((await fs.lstat(tests)).isSymbolicLink()) throw new Error('Source tests must not be a symlink.');
  for (const entry of await fs.readdir(tests, { withFileTypes: true })) if (/\.mjs$/.test(entry.name)) await add(path.join('tests', entry.name));
  if (await exists(path.join(project, '.github/workflows/check.yml'))) await add('.github/workflows/check.yml');
  return files.sort();
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; }

// Standard ZIP with UTF-8 filenames and DEFLATE; no external archiver or npm runtime dependency.
export function createZip(entries) {
  const local = [], central = []; let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt16LE(33, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26);
    local.push(head, filename, compressed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += head.length + filename.length + compressed.length;
  }
  if (entries.length >= 65535 || offset >= 0xffffffff) throw new Error('Source archive exceeds ZIP limits.');
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function safeOutput(project, target) {
  const parent = path.dirname(project);
  if (!inside(parent, target) || target === project || inside(project, target) || inside(target, project)) throw new Error('Output must be a separate directory within the source parent directory.');
  let cursor = parent;
  for (const piece of path.relative(parent, target).split(path.sep)) {
    cursor = path.join(cursor, piece);
    const info = await fs.lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error('Output must not traverse a symlink.');
  }
  if (await exists(target) || await exists(`${target}.zip`)) throw new Error('Output already exists. Use --out with a new directory; existing packages are never overwritten.');
}

export async function packageSource({ project = projectRoot, output } = {}) {
  project = path.resolve(project);
  const metadata = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Package version is invalid.');
  const target = path.resolve(output || path.join(path.dirname(project), `gongming-source-${metadata.version}`));
  await safeOutput(project, target);
  const files = await collectSourceEntries(project), entries = []; let totalBytes = 0;
  for (const relative of files) {
    const data = await fs.readFile(path.join(project, relative)); totalBytes += data.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Unexpectedly large source package; inspect the source allowlist.');
    // A small high-confidence guard, not a replacement for reviewing staged source.
    if (/\.(?:m?js|cjs|json|md|html|ya?ml|ps1|cmd)$/.test(relative) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data.toString())) throw new Error(`Private key material detected in ${relative}; package not written.`);
    entries.push({ name: relative, data });
  }
  const manifest = { name: metadata.name, version: metadata.version, includesUserData: false, files: entries.map(({ name, data }) => ({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
  entries.push({ name: 'SOURCE-MANIFEST.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  const zip = createZip(entries);
  await fs.mkdir(target, { recursive: true });
  for (const { name, data } of entries) { const destination = path.join(target, name); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, data, { flag: 'wx' }); }
  await fs.writeFile(`${target}.zip`, zip, { flag: 'wx' });
  return { output: target, archive: `${target}.zip`, version: metadata.version, files: files.length, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), includesUserData: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/package-source.mjs [--out NEW_DIRECTORY_BESIDE_SOURCE]');
  console.log(JSON.stringify(await packageSource({ output: args[1] }), null, 2));
}
