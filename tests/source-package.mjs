import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { collectSourceEntries, packageSource } from '../scripts/package-source.mjs';

async function fixture() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'gongming-source-package-')), project = path.join(parent, 'source');
  for (const folder of ['dist', 'lib', 'desktop', 'scripts', 'assets', 'tests', '.runtime', 'tests/backend-fixture-private', 'docs/screenshots']) await fs.mkdir(path.join(project, folder), { recursive: true });
  const files = ['package.json', 'server.mjs', 'README.md', 'ARCHITECTURE.md', 'GITHUB-PUBLISH.md', 'TESTING.md', 'DESKTOP.md', '启动Resonance.cmd', '.gitignore', 'dist/index.html', 'lib/engine.mjs', 'tests/example.mjs', '.runtime/state.json', 'tests/backend-fixture-private/secret.mjs'];
  for (const name of files) await fs.writeFile(path.join(project, name), name === 'package.json' ? JSON.stringify({ name: 'fixture', version: '0.4.1' }) : `fixture ${name}`);
  return { parent, project, output: path.join(parent, 'release') };
}

test('source package excludes private runtime and fixture data, and round-trips UTF-8 ZIP entries', async () => {
  const f = await fixture(), result = await packageSource(f);
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'SOURCE-MANIFEST.json'), 'utf8'));
  assert.equal(result.includesUserData, false);
  assert.ok(manifest.files.some(file => file.path === 'tests/example.mjs'));
  assert.ok(!manifest.files.some(file => file.path.includes('fixture-private') || file.path.startsWith('.runtime')));
  const zip = await fs.readFile(result.archive), decoded = new Map(); let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressed = zip.readUInt32LE(offset + 18), bytes = zip.readUInt32LE(offset + 22), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString(), start = offset + 30 + nameLength + extraLength;
    const data = inflateRawSync(zip.subarray(start, start + compressed)); assert.equal(data.length, bytes); decoded.set(name, data);
    offset = start + compressed;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(decoded.get('启动Resonance.cmd').toString(), 'fixture 启动Resonance.cmd');
  assert.equal(decoded.size, manifest.files.length + 1);
});

test('packaging refuses overwrites, source overlap, and embedded private keys', async () => {
  const f = await fixture(); await packageSource(f);
  await assert.rejects(() => packageSource(f), /already exists/);
  await assert.rejects(() => packageSource({ ...f, output: path.join(f.project, 'release') }), /separate directory/);
  await fs.writeFile(path.join(f.project, 'lib/private.mjs'), ['-----BEGIN ', 'PRIVATE KEY-----'].join(''));
  await assert.rejects(() => packageSource({ ...f, output: path.join(f.parent, 'second') }), /Private key material/);
  await assert.rejects(() => fs.stat(path.join(f.parent, 'second')), { code: 'ENOENT' });
});

test('source directory junctions cannot import data from outside the project', async () => {
  const f = await fixture(), outside = path.join(f.parent, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.mjs'), 'private fixture');
  await fs.symlink(outside, path.join(f.project, 'lib', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => collectSourceEntries(f.project), /symlinks/);
});
