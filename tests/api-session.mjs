import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createApiSession, PreviewStore} from '../lib/api-session.mjs';

test('credentials are random for each lifetime and require an exact bearer header', () => {
  const session = createApiSession();
  assert.notEqual(session.token, createApiSession().token);
  for (const authorization of [undefined, '', session.token, `Bearer ${session.token}x`, `Bearer ${'0'.repeat(64)}`]) assert.equal(session.accepts({headers: {authorization}}), false);
  assert.equal(session.accepts({headers: {authorization: `Bearer ${session.token}`}}), true);
});

test('preview capabilities are bounded, expire, and cannot select API permissions', () => {
  const store = new PreviewStore({maxEntries: 2, ttl: 500});
  const first = store.create('<p>first</p>');
  const second = store.create('<p>second</p>', true);
  store.create('<p>third</p>');
  assert.equal(store.get(first.split('/').pop()), null);
  const id = second.split('/').pop();
  assert.equal(store.get(id).scripts, true);
  store.items.get(id).expires = 0;
  assert.equal(store.get(id), null);
  assert.throws(() => store.create('x'.repeat(2 * 1024 * 1024 + 1)), {status: 400});
});

test('real server gates every API surface and delivers credentials only on owned IPC', {timeout: 30000}, async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'resonance-auth-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const child = spawn(process.execPath, [server, '--port', String(port)], {env: {...process.env, GONGMING_DATA_DIR: data}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (child.connected) child.send({type: 'gongming:shutdown'}); else child.kill();
      await exited;
    }
    await fs.rm(data, {recursive: true, force: true, maxRetries: 8, retryDelay: 50});
  });
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend readiness timed out')), 15000);
    child.on('message', message => { if (message.type === 'gongming:ready') { clearTimeout(timer); resolve(message.token); } });
    child.once('error', reject);
  });
  const origin = `http://127.0.0.1:${port}`;
  const authorized = (route, options = {}) => fetch(origin + route, {...options, headers: {...options.headers, Authorization: 'Bearer ' + token}});
  for (const route of ['/api/status', '/api/chats', '/api/audit', '/api/chats/no-id/stream', '/api/chats/no-id/attachments/no-id/0']) assert.equal((await fetch(origin + route)).status, 401, route);
  for (const route of ['/api/config', '/api/jobs', '/api/approvals/no-id', '/api/mcp/call', '/api/previews']) assert.equal((await fetch(origin + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 401, route);
  assert.equal((await authorized('/api/status')).status, 200);
  assert.equal((await authorized('/api/status', {headers: {Origin: 'null'}})).status, 403);
  assert.equal((await fetch(origin + '/api/status?token=' + token)).status, 401);
  const page = await fetch(origin);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp.split('script-src ')[1].split(';')[0], /unsafe-inline/);
  assert.ok(!(await page.text()).includes(token));
  assert.ok(!output.includes(token));
  const preview = await authorized('/api/previews', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({html: '<button>demo</button>', scripts: true})});
  assert.equal(preview.status, 201);
  const previewUrl = (await preview.json()).url;
  const previewResponse = await fetch(origin + previewUrl);
  assert.match(previewResponse.headers.get('content-security-policy'), /sandbox allow-scripts;/);
  assert.doesNotMatch(previewResponse.headers.get('content-security-policy'), /allow-same-origin/);
  assert.match(previewResponse.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(await previewResponse.text(), '<button>demo</button>');
  const files = await fs.readdir(data);
  for (const file of files.filter(file => file.endsWith('.json'))) assert.ok(!(await fs.readFile(path.join(data, file), 'utf8')).includes(token), file);
});
