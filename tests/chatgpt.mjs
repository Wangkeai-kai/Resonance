import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ChatGPTConnection } from '../lib/chatgpt.mjs';

const ISSUER = 'https://auth.openai.com';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const work = tmpdir();

function jwt(claims, alg = 'RS256', badSignature = false) {
  const encoded = [ { alg, kid: alg === 'ES256' ? 'ec' : 'rsa', typ: 'JWT' }, claims ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const key = alg === 'ES256' ? { key: ec.privateKey, dsaEncoding: 'ieee-p1363' } : rsa.privateKey;
  const signature = crypto.sign('sha256', Buffer.from(encoded), key);
  if (badSignature) signature[0] ^= 0xff;
  return `${encoded}.${signature.toString('base64url')}`;
}

function vault() {
  const key = crypto.randomBytes(32);
  return {
    async seal(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); },
    async unseal(text) { const raw = Buffer.from(text, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0,12)); decipher.setAuthTag(raw.subarray(12,28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(); },
  };
}

async function fixture(t, options = {}) {
  await fs.mkdir(work, { recursive: true });
  const runtime = await fs.mkdtemp(path.join(work, 'chatgpt-fixture-'));
  const harness = { now: Date.now(), options, calls: [], refreshes: 0, codes: 0, revocations: 0, sequence: 0, authorization: null, claims: {}, subject: 'fixture-user', email: 'test@example.invalid', scope: SCOPE, alg: 'RS256', expiresIn: 3600 };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url, init = {}) => {
    url = String(url); harness.calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, jwks_uri: harness.badJwks || `${ISSUER}/fixture-jwks`, revocation_endpoint: `${ISSUER}/fixture-revoke` });
    if (url === `${ISSUER}/fixture-jwks`) return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa', alg: 'RS256', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec', alg: 'ES256', use: 'sig' }] });
    if (url === TOKEN) {
      const form = new URLSearchParams(init.body), refreshing = form.get('grant_type') === 'refresh_token';
      if (refreshing) {
        harness.refreshes++;
        assert.equal(form.get('resource'), RESOURCE);
        assert.equal(form.has('scope'), false);
        if (harness.refreshError) return json({ error: harness.refreshError }, 400);
        await new Promise(resolve => setTimeout(resolve, 10));
      } else {
        harness.codes++;
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('resource'), RESOURCE);
        assert.equal(form.get('redirect_uri'), harness.authorization.searchParams.get('redirect_uri'));
        assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), harness.authorization.searchParams.get('code_challenge'));
        assert.equal(form.get('client_secret'), null);
        assert.notEqual(form.get('client_id'), 'dynamic_agent_client');
        if (harness.codeError) return json({ error: harness.codeError }, 400);
      }
      const sequence = ++harness.sequence;
      const claims = { iss: ISSUER, aud: form.get('client_id'), sub: harness.subject, email: harness.email, exp: Math.floor(harness.now / 1000) + 3600, nonce: harness.authorization.searchParams.get('nonce'), ...harness.claims };
      const result = { access_token: `fixture-access-${sequence}`, refresh_token: `fixture-refresh-${sequence}`, id_token: jwt(claims, harness.alg, harness.badSignature), token_type: 'Bearer', expires_in: harness.expiresIn, scope: harness.scope };
      if (refreshing && harness.omitRefreshId) delete result.id_token;
      return json(result);
    }
    if (url === `${RESOURCE}/models`) {
      if (harness.modelsError) return json({ error: 'fixture unavailable' }, 503);
      assert.match(init.headers.Authorization, /^Bearer fixture-access-/);
      return json({ models: [{ slug: 'fixture-model-a', display_name: 'Fixture Model A', visibility: 'list' }, { slug: 'internal', display_name: 'Internal model', visibility: 'hidden' }, { slug: 'fixture-model-b', display_name: 'Fixture Model B', visibility: 'list' }] });
    }
    if (url === `${ISSUER}/fixture-revoke`) {
      harness.revocations++;
      assert.equal(new URLSearchParams(init.body).get('token_type_hint'), 'refresh_token');
      return new Response(null, { status: harness.revokeError ? 503 : 200 });
    }
    throw new Error(`Unexpected mocked fetch URL: ${url}`);
  };
  const connection = await new ChatGPTConnection(runtime, { vault: options.vault, fetch: fetcher, now: () => harness.now, attemptMs: options.attemptMs || 300000 }).init();
  t.after(() => connection.close());
  harness.connection = connection; harness.fetcher = fetcher; harness.runtime = runtime;
  harness.begin = async accountId => { harness.authorization = new URL((await connection.start(accountId)).authorizationUrl); return harness.authorization; };
  harness.callback = async (extra = {}) => { const url = new URL(harness.authorization.searchParams.get('redirect_uri')); for (const [key,value] of Object.entries({ state: harness.authorization.searchParams.get('state'), code: 'fixture-code', client_id: harness.authorization.searchParams.get('client_id') === 'dynamic_agent_client' ? `oaiapp_fixture_${harness.codes + 1}` : harness.authorization.searchParams.get('client_id'), ...extra })) { if (value !== null) url.searchParams.set(key, value); } return fetch(url); };
  harness.login = async (extra = {}, accountId) => { await harness.begin(accountId); const response = await harness.callback(extra); assert.equal(response.status, 200, await response.text()); return connection.status().accounts.at(-1); };
  return harness;
}

test('loopback PKCE sign-in validates RS256 identity, discovers account models, and stores no plaintext tokens', async t => {
  const h = await fixture(t, { vault: vault() });
  const before = await h.begin();
  assert.equal(before.origin, ISSUER);
  assert.equal(before.pathname, '/api/accounts/authorize');
  assert.equal(before.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(before.searchParams.get('agent_name_hint'), 'Gongming');
  assert.match(before.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(before.searchParams.get('scope'), SCOPE);
  assert.equal(before.searchParams.get('resource'), RESOURCE);
  assert.equal(before.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!JSON.stringify(h.connection.status()).includes(before.searchParams.get('state')));
  const wrong = await h.callback({ state: 'wrong-state' });
  assert.equal(wrong.status, 400); assert.equal(h.codes, 0); assert.ok(h.connection.status().pending);
  const response = await h.callback({ client_id: 'oaiapp_fixture_main' });
  assert.equal(response.status, 200, await response.text());
  const status = h.connection.status(), account = status.accounts[0];
  assert.equal(status.pending, null); assert.equal(status.storage, 'encrypted');
  assert.equal(account.connected, true); assert.equal(account.planEnabled, true);
  assert.deepEqual(account.models.map(m => m.id), ['fixture-model-a', 'fixture-model-b']);
  assert.equal(await h.connection.accessToken(account.id), 'fixture-access-1');
  const disk = await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8');
  assert.ok(!disk.includes('fixture-access-1') && !disk.includes('fixture-refresh-1'));
  assert.ok(!JSON.stringify(status).includes('sealed') && !JSON.stringify(status).includes('clientId'));
  assert.equal(h.calls.filter(c => c.url.endsWith('/responses')).length, 0);
  assert.deepEqual((await fs.readdir(h.runtime)).sort(), ['chatgpt-accounts.json', 'chatgpt-owner.lock']);
});

test('memory mode retains host and registrations but requires login after restart; returning flow reuses client', async t => {
  const h = await fixture(t);
  const account = await h.login({ client_id: 'oaiapp_saved' });
  const first = h.authorization;
  await h.begin(account.id);
  assert.equal(h.authorization.searchParams.get('client_id'), 'oaiapp_saved');
  assert.equal(h.authorization.searchParams.has('agent_name_hint'), false);
  assert.equal(h.authorization.searchParams.has('id_token_hint'), false);
  assert.equal(h.authorization.searchParams.get('login_hint'), h.email);
  assert.equal(h.authorization.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  for (const name of ['state', 'nonce', 'code_challenge']) assert.notEqual(h.authorization.searchParams.get(name), first.searchParams.get(name));
  assert.equal((await h.callback({ client_id: null })).status, 200);
  assert.equal(h.connection.status().accounts.length, 1);
  await h.connection.close();
  const next = await new ChatGPTConnection(h.runtime, { fetch: h.fetcher }).init(); t.after(() => next.close());
  assert.equal(next.status().accounts[0].connected, false);
  const nextUrl = new URL((await next.start(account.id)).authorizationUrl);
  assert.equal(nextUrl.searchParams.get('client_id'), 'oaiapp_saved');
  assert.equal(nextUrl.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  const disk = await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8');
  assert.ok(!disk.includes('fixture-access') && !disk.includes('fixture-refresh') && !disk.includes('eyJ'));
});

test('ES256 identity and separate registrations with the same email remain distinct', async t => {
  const h = await fixture(t, { vault: vault() }); h.alg = 'ES256';
  const a = await h.login({ client_id: 'oaiapp_first' });
  const b = await h.login({ client_id: 'oaiapp_second' });
  assert.notEqual(a.id, b.id); assert.equal(a.email, b.email); assert.notEqual(a.label, b.label);
  assert.equal(h.connection.status().accounts.length, 2);
  assert.equal(await h.connection.accessToken(a.id), 'fixture-access-1');
  assert.equal(await h.connection.accessToken(b.id), 'fixture-access-2');
});

test('bad signatures, nonce, audience, issuer, expiry, and returning identities never replace credentials', async t => {
  const h = await fixture(t);
  const account = await h.login({ client_id: 'oaiapp_valid' });
  for (const claims of [{ nonce: 'wrong' }, { aud: 'other-client' }, { iss: 'https://example.invalid' }, { exp: 1 }, { sub: 'different-person' }]) {
    h.claims = claims; await h.begin(account.id);
    assert.equal((await h.callback()).status, 400);
    assert.equal(await h.connection.accessToken(account.id), 'fixture-access-1');
  }
  h.claims = {}; h.badSignature = true; await h.begin(account.id);
  assert.equal((await h.callback()).status, 400); h.badSignature = false;
  await h.begin(account.id); const beforeCodes = h.codes;
  assert.equal((await h.callback({ client_id: 'oaiapp_mismatch' })).status, 400);
  assert.equal(h.codes, beforeCodes);
  assert.equal(await h.connection.accessToken(account.id), 'fixture-access-1');
});

test('missing issued client, dynamic callback and authorization denial cannot exchange tokens', async t => {
  const h = await fixture(t);
  for (const result of [{ client_id: null }, { client_id: 'dynamic_agent_client' }, { error: 'access_denied', code: null }]) {
    await h.begin(); assert.equal((await h.callback(result)).status, 400);
  }
  assert.equal(h.codes, 0); assert.equal(h.connection.status().accounts.length, 0);
  h.codeError = 'invalid_grant'; await h.begin(); assert.equal((await h.callback({ client_id: 'oaiapp_retry' })).status, 401);
  await h.begin(); assert.equal(h.authorization.searchParams.get('client_id'), 'oaiapp_retry');
  assert.equal(h.authorization.searchParams.has('agent_name_hint'), false);
});

test('untrusted discovery metadata is rejected before following JWKS or sending credentials', async t => {
  const h = await fixture(t); h.badJwks = 'https://untrusted.example/jwks';
  await h.begin(); assert.equal((await h.callback()).status, 400);
  assert.ok(!h.calls.some(c => c.url.includes('untrusted.example')));
  assert.equal(h.connection.status().accounts.length, 0);
});

test('identity-only scope cannot use plan tokens or trigger model listing', async t => {
  const h = await fixture(t); h.scope = 'openid profile email';
  const account = await h.login();
  assert.equal(account.connected, true); assert.equal(account.planEnabled, false);
  assert.equal(h.calls.filter(c => c.url === `${RESOURCE}/models`).length, 0);
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_plan_permission_required');
});

test('near-expiry refreshes serialize, rotate atomically, and survive encrypted restart', async t => {
  const encryption = vault(), h = await fixture(t, { vault: encryption });
  const account = await h.login({ client_id: 'oaiapp_refresh' });
  h.now += 3550 * 1000; h.omitRefreshId = true;
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => h.connection.accessToken(account.id))), Array(8).fill('fixture-access-2'));
  assert.equal(h.refreshes, 1);
  const firstRefresh = h.calls.find(c => c.url === TOKEN && new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token');
  assert.equal(new URLSearchParams(firstRefresh.init.body).get('refresh_token'), 'fixture-refresh-1');
  await h.connection.close();
  const restored = await new ChatGPTConnection(h.runtime, { vault: encryption, fetch: h.fetcher, now: () => h.now }).init(); t.after(() => restored.close());
  assert.equal(restored.connected(account.id), true);
  assert.equal(await restored.accessToken(account.id), 'fixture-access-2');
  h.now += 3550 * 1000; await restored.accessToken(account.id);
  const refreshCalls = h.calls.filter(c => c.url === TOKEN && new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token');
  assert.equal(new URLSearchParams(refreshCalls[1].init.body).get('refresh_token'), 'fixture-refresh-2');
});

test('invalid refresh clears the unusable session and redacts old and rotated tokens', async t => {
  const h = await fixture(t, { vault: vault() });
  const account = await h.login(); h.now += 3550 * 1000; h.refreshError = 'invalid_grant';
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_invalid_grant');
  assert.equal(h.connection.connected(account.id), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8')).accounts[0].sealed, undefined);
  const redacted = h.connection.redact('fixture-access-1 fixture-refresh-1 Bearer other-token ?id_token_hint=private&code=secret');
  assert.ok(!redacted.includes('fixture-access-1') && !redacted.includes('fixture-refresh-1') && !redacted.includes('private') && !redacted.includes('secret'));
});

test('logout revokes session and clears credentials while retaining registration and host', async t => {
  const h = await fixture(t, { vault: vault() });
  const account = await h.login({ client_id: 'oaiapp_logout' }), host = h.authorization.searchParams.get('ext_agent_host_id');
  assert.deepEqual(await h.connection.logout(account.id), { revocationConfirmed: true, warning: null });
  assert.equal(h.revocations, 1); assert.equal(h.connection.connected(account.id), false);
  const revoke = h.calls.find(c => c.url.endsWith('/fixture-revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('client_id'), 'oaiapp_logout');
  const disk = JSON.parse(await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8'));
  assert.equal(disk.accounts[0].clientId, 'oaiapp_logout'); assert.equal(disk.accounts[0].sealed, undefined); assert.equal(disk.hostId, host);
  await h.begin(account.id); assert.equal(h.authorization.searchParams.get('client_id'), 'oaiapp_logout');
  assert.equal(h.authorization.searchParams.has('id_token_hint'), false);
});

test('failed revocation retries and still logs out locally with an explicit warning', async t => {
  const h = await fixture(t); const account = await h.login(); h.revokeError = true;
  const result = await h.connection.logout(account.id);
  assert.equal(result.revocationConfirmed, false); assert.match(result.warning, /无法确认远程撤销/);
  assert.equal(h.revocations, 3); assert.equal(h.connection.connected(account.id), false);
});

test('model discovery failure leaves verified sign-in intact without doing inference', async t => {
  const h = await fixture(t); h.modelsError = true;
  const account = await h.login();
  assert.equal(account.connected, true); assert.equal(account.models.length, 0);
  assert.match(h.connection.status().error, /模型列表/);
  h.modelsError = false;
  assert.equal((await h.connection.models(account.id)).length, 2);
});

test('unavailable encryption cannot replace a successful existing login', async t => {
  const encryption = vault(), h = await fixture(t, { vault: encryption });
  const account = await h.login({ client_id: 'oaiapp_storage' });
  const before = await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8');
  encryption.seal = async () => { throw new Error('fixture unavailable'); };
  await h.begin(account.id); assert.equal((await h.callback()).status, 400);
  assert.equal(await h.connection.accessToken(account.id), 'fixture-access-1');
  assert.equal(await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8'), before);
});

test('refresh identity failures discard the consumed old refresh token', async t => {
  const h = await fixture(t, { vault: vault() }); const account = await h.login();
  h.now += 3550 * 1000; h.claims = { sub: 'wrong-refreshed-user' };
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_identity_invalid');
  assert.equal(h.connection.connected(account.id), false);
  assert.equal(h.refreshes, 1);
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_login_required');
  assert.equal(h.refreshes, 1);
});

test('failed encryption during rotation retains only the newest token in memory and clears stale disk credentials', async t => {
  const encryption = vault(), h = await fixture(t, { vault: encryption });
  const account = await h.login(); h.now += 3550 * 1000;
  encryption.seal = async () => { throw new Error('fixture lock unavailable'); };
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_storage_error');
  assert.equal(await h.connection.accessToken(account.id), 'fixture-access-2');
  assert.equal(h.refreshes, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.runtime, 'chatgpt-accounts.json'), 'utf8')).accounts[0].sealed, undefined);
  assert.match(h.connection.status().error, /仅本次启动/);
  assert.equal(h.connection.status().storage, 'memory');
});

test('concurrent logout waits for refresh, revokes the replacement, and leaves no usable session', async t => {
  const h = await fixture(t, { vault: vault() }); const account = await h.login(); h.now += 3550 * 1000;
  const refreshing = h.connection.accessToken(account.id);
  while (!h.refreshes) await new Promise(resolve => setTimeout(resolve, 1));
  const signingOut = h.connection.logout(account.id);
  await refreshing; assert.equal((await signingOut).revocationConfirmed, true);
  const revoke = h.calls.find(c => c.url.endsWith('/fixture-revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'fixture-refresh-2');
  assert.equal(h.connection.connected(account.id), false);
  await assert.rejects(() => h.connection.accessToken(account.id), e => e.code === 'chatgpt_login_required');
});

test('ciphertext cannot be reassigned to another account by changing plaintext metadata', async t => {
  const encryption = vault(), h = await fixture(t, { vault: encryption });
  await h.login({ client_id: 'oaiapp_first' }); await h.login({ client_id: 'oaiapp_second' });
  await h.connection.close();
  const file = path.join(h.runtime, 'chatgpt-accounts.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  [saved.accounts[0].sealed, saved.accounts[1].sealed] = [saved.accounts[1].sealed, saved.accounts[0].sealed];
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = await new ChatGPTConnection(h.runtime, { vault: encryption, fetch: h.fetcher }).init(); t.after(() => restored.close());
  assert.ok(restored.status().accounts.every(account => !account.connected));
  assert.match(restored.status().error, /重新登录/);
});

test('close cancels callback listener and start never leaks the PKCE verifier', async t => {
  const h = await fixture(t); await h.begin();
  await assert.rejects(() => h.connection.start(), e => e.code === 'chatgpt_login_pending');
  assert.equal(h.authorization.searchParams.has('code_verifier'), false);
  await h.connection.close(); assert.equal(h.connection.status().pending, null);
  await assert.rejects(() => h.callback());
});

test('runtime owner lock prevents two processes from racing one rotating session', async t => {
  const h = await fixture(t, { vault: vault() });
  await assert.rejects(() => new ChatGPTConnection(h.runtime, { fetch: h.fetcher }).init(), e => e.code === 'chatgpt_runtime_in_use');
  await h.connection.close();
  assert.equal(await fs.access(path.join(h.runtime, 'chatgpt-owner.lock')).then(() => true, () => false), false);
  const replacement = await new ChatGPTConnection(h.runtime, { fetch: h.fetcher }).init(); t.after(() => replacement.close());
  assert.equal(replacement.status().storage, 'memory');
});
