import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planInput, planRequest } from '../lib/plan-inference.mjs';
import { ModelGateway } from '../lib/models.mjs';

const provider = { id: 'plan-test', type: 'chatgpt-plan', name: 'ChatGPT fixture', accountId: 'account-test', baseUrl: 'https://api.openai.com/v1', model: 'fixture-model' };
const connection = () => ({ tokensRequested: [], async accessToken(accountId) { this.tokensRequested.push(accountId); return 'fixture-oauth-token'; }, redact(text) { return String(text).replaceAll('fixture-oauth-token', '[REDACTED]'); } });
const delta = text => ({ type: 'response.output_text.delta', delta: text });
const completed = (extra = {}) => ({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 45, output_tokens: 12 }, ...extra } });
const frame = (value, newline = '\n') => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;

function stream(text, chunkSize = 11, status = 200) {
  const source = new TextEncoder().encode(text); let offset = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { if (offset >= source.length) { controller.close(); return; } controller.enqueue(source.subarray(offset, Math.min(source.length, offset + chunkSize))); offset += chunkSize; },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } }), cancelled: () => cancelled };
}

test('planInput preserves conversation text and images and moves system/developer instructions out of input', () => {
  const image = 'data:image/png;base64,aW1hZ2U=';
  const result = planInput([
    { role: 'system', content: 'You are useful.' }, { role: 'developer', content: [{ type: 'text', text: 'Use Chinese.' }] },
    { role: 'user', content: [{ type: 'text', text: '请看图片' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '已经阅读图片。' }] }, { role: 'user', content: '继续分析' },
  ]);
  assert.equal(result.instructions, 'You are useful.\nUse Chinese.');
  assert.deepEqual(result.input, [
    { role: 'user', content: [{ type: 'input_text', text: '请看图片' }, { type: 'input_image', image_url: image, detail: 'high' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '已经阅读图片。' }] }, { role: 'user', content: '继续分析' },
  ]);
  assert.equal(result.store, false); assert.equal(result.stream, true);
  for (const invalid of [null, [{ role: 'tool', content: 'invalid' }], [{ role: 'user', content: null }], [{ role: 'user', content: [{ type: 'input_audio', data: 'audio' }] }], [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: image } }] }]]) assert.throws(() => planInput(invalid), error => error.status === 400);
});

test('SSE deltas survive bytewise UTF-8 and CRLF boundaries and require response.completed', async () => {
  const oauth = connection(), bytes = stream(frame(delta('你好，'), '\r\n') + frame(delta('世界'), '\r\n') + frame(completed(), '\r\n') + ': keepalive\r\n\r\n'.repeat(10), 1);
  let request;
  const result = await planRequest(oauth, provider, [{ role: 'user', content: 'hello' }], { fetch: async (url, init) => { request = { url, init }; return bytes.response; } });
  assert.equal(result.text, '你好，世界'); assert.deepEqual(result.usage, { input: 45, output: 12 });
  assert.equal(result.provider, provider.id); assert.equal(result.model, provider.model);
  assert.deepEqual(oauth.tokensRequested, [provider.accountId]);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.headers.Authorization, 'Bearer fixture-oauth-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, provider.model); assert.equal(body.store, false); assert.equal(body.stream, true);
  for (const unsupported of ['max_output_tokens', 'previous_response_id', 'temperature', 'background', 'conversation', 'metadata']) assert.equal(Object.hasOwn(body, unsupported), false);
  assert.ok(!JSON.stringify(body).includes('fixture-oauth-token'));
  assert.equal(bytes.cancelled(), true);
});

test('completed response output is a valid fallback when delta events were not supplied', async () => {
  const text = frame(completed({ output: [{ type: 'message', content: [{ type: 'output_text', text: '完整文本 fixture-oauth-token' }] }] }));
  const result = await planRequest(connection(), provider, [{ role: 'user', content: 'test' }], { fetch: async () => stream(text).response });
  assert.equal(result.text, '完整文本 [REDACTED]');
});

test('interrupted, failed, incomplete, and DONE-only streams cannot report success', async () => {
  for (const ending of ['', 'data: [DONE]\n\n', frame({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }), frame({ type: 'response.incomplete', response: {} }), frame({ type: 'error', message: 'fixture failure' })]) {
    const reply = stream(frame(delta('partial answer')) + ending);
    await assert.rejects(() => planRequest(connection(), provider, [{ role: 'user', content: 'test' }], { fetch: async () => reply.response }), /未完整|中断/);
  }
});

test('malformed events and false completed states cannot convert partial text to success', async () => {
  for (const body of [
    frame(delta('partial')) + 'data: not-json\n\n',
    frame({ type: 'response.output_text.delta', delta: { bad: true } }) + frame(completed()),
    frame(delta('partial')) + frame({ type: 'response.completed' }),
    frame(delta('partial')) + frame(completed({ status: 'incomplete' })),
    frame(completed({ output: [] })),
  ]) await assert.rejects(() => planRequest(connection(), provider, [{ role: 'user', content: 'test' }], { fetch: async () => stream(body).response }));
});

test('HTTP 401 and 429 stop without retry or displaying upstream secret-bearing content', async () => {
  for (const status of [401, 429]) {
    let requests = 0;
    await assert.rejects(() => planRequest(connection(), provider, [{ role: 'user', content: 'test' }], { fetch: async () => { requests++; return stream('fixture-oauth-token is invalid', 1, status).response; } }), error => {
      assert.equal(error.status, status); assert.ok(!error.message.includes('fixture-oauth-token'));
      assert.match(error.message, status === 401 ? /重新登录/ : /用量限制/); return true;
    });
    assert.equal(requests, 1);
  }
});

test('OAuth tokens are never acquired or sent for custom or lookalike API addresses', async () => {
  for (const baseUrl of ['https://example.invalid/v1', 'https://api.openai.com.evil.invalid/v1', 'http://api.openai.com/v1', 'https://api.openai.com/v1?redirect=bad', 'https://user@api.openai.com/v1', 'https://api.openai.com/v1/']) {
    const oauth = connection(); let fetched = false;
    await assert.rejects(() => planRequest(oauth, { ...provider, baseUrl }, [{ role: 'user', content: 'test' }], { fetch: async () => { fetched = true; throw new Error('should not fetch'); } }), /官方 API 地址/);
    assert.equal(oauth.tokensRequested.length, 0); assert.equal(fetched, false);
  }
});

test('cancelled and unsupported input requests stop before token access or inference', async () => {
  const oauth = connection(), controller = new AbortController(); controller.abort(); let fetched = false;
  const options = { fetch: async () => { fetched = true; throw new Error('should not fetch'); } };
  await assert.rejects(() => planRequest(oauth, provider, [{ role: 'user', content: 'test' }], { ...options, signal: controller.signal }), /暂停/);
  await assert.rejects(() => planRequest(oauth, provider, [{ role: 'user', content: [{ type: 'video' }] }], options));
  assert.equal(oauth.tokensRequested.length, 0); assert.equal(fetched, false);
});

test('model gateway requires a connected account with actual plan permission', () => {
  const gateway = new ModelGateway({ config: { providers: [provider], agentProviders: {} } }, new Map(), async () => {});
  assert.throws(() => gateway.providerById(provider.id), /授权套餐/);
  gateway.chatgpt = { connected: () => true, status: () => ({ accounts: [{ id: provider.accountId, planEnabled: false }] }) };
  assert.throws(() => gateway.providerById(provider.id), /授权套餐/);
  gateway.chatgpt.status = () => ({ accounts: [{ id: provider.accountId, planEnabled: true }] });
  assert.equal(gateway.providerById(provider.id), provider);
  assert.equal(gateway.provider('orchestrator'), provider);
  gateway.chatgpt.connected = () => false;
  assert.throws(() => gateway.providerById(provider.id), /授权套餐/);
});

test('gateway routes ChatGPT plans to official Responses without consuming API keys or retrying inference', async () => {
  const gateway = new ModelGateway({ config: { providers: [provider], agentProviders: {} } }, new Map([[provider.id, 'must-not-send-api-key']]), async () => {});
  gateway.chatgpt = connection();
  let requests = 0;
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => { requests++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.headers.Authorization, 'Bearer fixture-oauth-token'); assert.ok(!JSON.stringify(init).includes('must-not-send-api-key')); return stream(frame(delta('hello')) + frame(completed())).response; };
    const response = await gateway.request(provider, [{ role: 'user', content: 'hello' }], 2000);
    assert.equal(response.text, 'hello'); assert.equal(requests, 1);
    globalThis.fetch = async () => { requests++; return new Response('fixture-oauth-token', { status: 429 }); };
    await assert.rejects(() => gateway.request(provider, [{ role: 'user', content: 'hello' }], 2000), error => error.status === 429);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = previous; }
});
