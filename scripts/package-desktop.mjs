import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = path.dirname(project);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--runtime', '--out'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Usage: node scripts/package-desktop.mjs [--runtime ELECTRON_DIST] [--out DIRECTORY_INSIDE_OUTPUTS]');
  }
  options[args[i].slice(2)] = args[i + 1];
}
const runtime = path.resolve(options.runtime || process.env.GONGMING_ELECTRON_DIST || path.join(project, 'node_modules/electron/dist'));
const target = path.resolve(options.out || path.join(outputs, 'Resonance-Desktop'));
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};
if (!inside(outputs, target) || target === project || inside(project, target) || inside(target, project)) {
  throw new Error('Output must be a separate directory inside outputs, never the source directory or its parent.');
}
if (target === runtime || inside(runtime, target) || inside(target, runtime)) throw new Error('Runtime and output must not overlap.');

// Never recursively delete a target. Refuse symlinks and copy only known inputs.
async function safeDestination(destination) {
  if (destination !== target && !inside(target, destination)) throw new Error('Destination escaped the build directory.');
  let cursor = outputs;
  for (const part of path.relative(outputs, destination).split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await fs.lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error(`Refusing symlink in build destination: ${path.relative(outputs, cursor)}`);
  }
}
const forbidden = name => /^(?:\.runtime|\.openai|\.env(?:\..*)?|node_modules|\.git|work|tests?|test-results|coverage)$/i.test(name);
async function ensureNoPrivateFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || forbidden(entry.name)) throw new Error(`Private or unexpected path already exists in package: ${entry.name}. Choose a new output directory.`);
    if (entry.isDirectory()) await ensureNoPrivateFiles(path.join(directory, entry.name));
  }
}
let copied = 0;
async function copy(source, destination, { application = false } = {}) {
  await safeDestination(destination);
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing source symlink: ${path.basename(source)}`);
  if (info.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (application && forbidden(name)) continue;
      if (!application && (name === 'default_app.asar' || name === 'app')) continue;
      if (!application && path.basename(source) === 'locales' && !['en-US.pak','zh-CN.pak','zh-TW.pak'].includes(name)) continue;
      await copy(path.join(source, name), path.join(destination, name), { application });
    }
  } else if (info.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    copied++;
  }
}
async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function allowWindowsSandboxRead() {
  if (process.platform !== 'win32') return;
  // Electron's sandbox must be able to read the public program files. Never
  // apply this permission to a source, runtime, parent, or user-data directory.
  await safeDestination(target);
  const [resolvedTarget, resolvedOutputs, resolvedProject, resolvedRuntime] = await Promise.all([
    fs.realpath(target), fs.realpath(outputs), fs.realpath(project), fs.realpath(runtime),
  ]);
  if (!inside(resolvedOutputs, resolvedTarget)
    || resolvedTarget === resolvedProject || inside(resolvedProject, resolvedTarget) || inside(resolvedTarget, resolvedProject)
    || resolvedTarget === resolvedRuntime || inside(resolvedRuntime, resolvedTarget) || inside(resolvedTarget, resolvedRuntime)) {
    throw new Error('Refusing to change permissions outside the isolated package output directory.');
  }
  await ensureNoPrivateFiles(resolvedTarget);
  try {
    await execFileAsync('icacls.exe', [resolvedTarget, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], {
      shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Windows package permission setup failed. Electron's sandbox needs ALL APPLICATION PACKAGES read/execute access to this program directory. Packaging did not complete: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
}

await safeDestination(target);
const executable = path.join(runtime, 'electron.exe');
if (!(await fs.stat(executable).catch(() => null))?.isFile()) throw new Error('Electron Windows runtime not found. Run npm install on Windows, or provide --runtime pointing to an extracted Windows Electron dist directory.');
const electronVersion = (await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim().replace(/^v/, '');
const metadata = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
await ensureNoPrivateFiles(target);
await fs.mkdir(target, { recursive: true });
for (const entry of await fs.readdir(runtime)) {
  await copy(path.join(runtime, entry), path.join(target, entry === 'electron.exe' ? 'Resonance.exe' : entry));
}
const appTarget = path.join(target, 'resources', 'app');
await safeDestination(appTarget);
await fs.mkdir(appTarget, { recursive: true });
for (const relative of ['desktop', 'assets', 'dist', 'lib', 'server.mjs']) {
  await copy(path.join(project, relative), path.join(appTarget, relative), { application: true });
}
const appMetadata = { name: metadata.name, productName: 'Resonance', version: metadata.version, private: true, type: 'module', main: 'desktop/main.cjs' };
await fs.writeFile(path.join(appTarget, 'package.json'), `${JSON.stringify(appMetadata, null, 2)}\n`);
if (await fs.stat(path.join(project, 'DESKTOP.md')).catch(() => null)) await copy(path.join(project, 'DESKTOP.md'), path.join(target, 'DESKTOP.md'));
for (const file of ['install.ps1','install.cmd']) await copy(path.join(project,'desktop',file),path.join(target,file));
const sourceDigest = await sha256(executable);
if (sourceDigest !== await sha256(path.join(target, 'Resonance.exe'))) throw new Error('Copied executable checksum mismatch.');
const manifest = { app: 'Resonance', version: metadata.version, electronVersion, platform: 'win32', executable: 'Resonance.exe', executableSha256: sourceDigest, builtAt: new Date().toISOString(), includesUserData: false };
await fs.writeFile(path.join(target, 'build-info.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await ensureNoPrivateFiles(target);
await allowWindowsSandboxRead();
console.log(JSON.stringify({ output: target, executable: path.join(target, 'Resonance.exe'), filesCopied: copied, ...manifest }, null, 2));
