import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { HttpError } from './safety.mjs';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const random = () => crypto.randomBytes(32).toString('base64url');
const safeString = (value, max = 20000) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const issuedClient = value => safeString(value, 256) && value !== 'dynamic_agent_client' && /^[A-Za-z0-9_.-]+$/.test(value);
const failure = (message, code = 'chatgpt_connection_failed', status = 400) => new HttpError(status, message, code);
const accountCopy = account => ({ id: account.id, clientId: account.clientId, subject: account.subject, issuer: account.issuer, email: account.email, label: account.label, planEnabled: account.planEnabled, models: account.models || [], ...(account.sealed ? { sealed: account.sealed } : {}) });

// Official Sign in with ChatGPT public-client flow. No Codex files, browser
// cookies, passwords, partner keys, or inference requests are used here.
export class ChatGPTConnection {
  constructor(runtime, { vault = null, fetch: fetcher = globalThis.fetch, now = Date.now, attemptMs = 300000 } = {}) {
    this.runtime = path.resolve(runtime);
    this.file = path.join(this.runtime, 'chatgpt-accounts.json');
    this.ownerFile = path.join(this.runtime, 'chatgpt-owner.lock');
    this.vault = vault && typeof vault.seal === 'function' && typeof vault.unseal === 'function' ? vault : null;
    this.fetch = fetcher; this.now = now; this.attemptMs = attemptMs;
    this.accounts = []; this.credentials = new Map(); this.blocked = new Set();
    this.sessionLocks = new Map(); this.saveChain = Promise.resolve(); this.pending = null;
    this.error = null; this.knownSecrets = new Set(); this.closed = false;
  }

  async init() {
    await fs.mkdir(this.runtime, { recursive: true, mode: 0o700 });
    await this._acquireOwner();
    try {
    let saved;
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('无法读取 ChatGPT 本地连接记录，请检查文件权限或备份。', 'chatgpt_storage_error'); }
    if (saved) {
      if (saved.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(saved.hostId) || !Array.isArray(saved.accounts)) throw failure('ChatGPT 连接记录格式无效。', 'chatgpt_storage_error');
      this.hostId = saved.hostId;
      const ids = new Set(), clients = new Set();
      for (const account of saved.accounts) {
        if (!/^chatgpt-[0-9a-f-]{36}$/i.test(account.id) || ids.has(account.id) || !issuedClient(account.clientId) || clients.has(account.clientId) || !safeString(account.subject, 1000) || account.issuer !== ISSUER) throw failure('ChatGPT 账号注册记录无效。', 'chatgpt_storage_error');
        ids.add(account.id); clients.add(account.clientId);
        account.email = typeof account.email === 'string' ? account.email.slice(0, 320) : '';
        account.label = typeof account.label === 'string' ? account.label.slice(0, 400) : `ChatGPT · ${account.id.slice(-6)}`;
        account.models = this._cleanModels(account.models, true);
        const entry = accountCopy(account); this.accounts.push(entry);
        if (entry.sealed && this.vault) {
          try {
            const credential = JSON.parse(await this.vault.unseal(entry.sealed));
            if (!safeString(credential.accessToken) || !Number.isFinite(credential.expiresAt) || !Array.isArray(credential.scopes) || (credential.refreshToken && !safeString(credential.refreshToken)) || credential.registration?.clientId !== entry.clientId || credential.registration?.subject !== entry.subject || credential.registration?.issuer !== ISSUER) throw new Error('invalid');
            this.credentials.set(entry.id, credential); entry.planEnabled=credential.scopes.includes(PLAN_SCOPE); this._remember(credential);
          } catch { this.error = '无法解密已保存的 ChatGPT 登录，请重新登录此账号。'; }
        }
      }
    } else { this.hostId = `urn:uuid:${crypto.randomUUID()}`; await this._save(); }
    return this;
    } catch (error) { await this._releaseOwner(); throw error; }
  }

  async _acquireOwner() {
    const record = JSON.stringify({ pid: process.pid, instance: crypto.randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await fs.writeFile(this.ownerFile, record, { flag: 'wx', mode: 0o600 }); this.ownerRecord = record; return; }
      catch (error) { if (error.code !== 'EEXIST') throw failure('无法锁定本地 ChatGPT 连接记录。', 'chatgpt_storage_error'); }
      let current, owner;
      try { current = await fs.readFile(this.ownerFile, 'utf8'); owner = JSON.parse(current); } catch { throw failure('ChatGPT 连接记录正由另一服务使用，请关闭其他共鸣窗口后重试。', 'chatgpt_runtime_in_use', 409); }
      let alive = true;
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; } }
      if (alive) throw failure('ChatGPT 连接记录正由另一服务使用，请关闭其他共鸣窗口后重试。', 'chatgpt_runtime_in_use', 409);
      // Only reclaim an unchanged lock from a process confirmed to be gone.
      if (await fs.readFile(this.ownerFile, 'utf8') === current) await fs.unlink(this.ownerFile);
    }
    throw failure('无法锁定本地 ChatGPT 连接记录，请重试。', 'chatgpt_runtime_in_use', 409);
  }
  async _releaseOwner() {
    if (!this.ownerRecord) return;
    try { if (await fs.readFile(this.ownerFile, 'utf8') === this.ownerRecord) await fs.unlink(this.ownerFile); } catch {}
    this.ownerRecord = null;
  }

  _remember(credential) { for (const name of ['accessToken', 'refreshToken', 'idToken']) if (credential[name]) this.knownSecrets.add(credential[name]); }
  redact(text) {
    let value = String(text);
    for (const secret of this.knownSecrets) value = value.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
    return value.replace(/([?&](?:id_token_hint|code|code_verifier|access_token|refresh_token)=)[^&\s]*/gi, '$1[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  }
  connected(accountId) {
    const credential = this.credentials.get(accountId);
    return !this.closed && !this.blocked.has(accountId) && Boolean(credential && (credential.expiresAt > this.now() || credential.refreshToken));
  }
  status() {
    return { accounts: this.accounts.map(account => ({ id: account.id, email: account.email, label: account.label, connected: this.connected(account.id), planEnabled: Boolean(account.planEnabled), models: structuredClone(account.models || []) })), pending: this.pending ? { accountId: this.pending.accountId || null, startedAt: this.pending.startedAt, expiresAt: this.pending.expiresAt } : null, error: this.error, storage: this.vault && !this.accounts.some(account=>this.credentials.has(account.id)&&!account.sealed) ? 'encrypted' : 'memory' };
  }
  _account(accountId) { const account = this.accounts.find(item => item.id === accountId); if (!account) throw failure('请选择已有 ChatGPT 账号或重新登录。', 'chatgpt_account_missing', 404); return account; }
  _lock(accountId, fn) {
    const result = (this.sessionLocks.get(accountId) || Promise.resolve()).then(fn);
    const settled = result.catch(() => {}); this.sessionLocks.set(accountId, settled);
    void settled.then(() => { if (this.sessionLocks.get(accountId) === settled) this.sessionLocks.delete(accountId); });
    return result;
  }
  _save() {
    const operation = this.saveChain.catch(() => {}).then(async () => {
      const snapshot = JSON.stringify({ version: 1, hostId: this.hostId, accounts: this.accounts.map(accountCopy) }, null, 2);
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } catch { await fs.unlink(temporary).catch(() => {}); throw failure('无法保存 ChatGPT 连接记录，请检查本地文件权限。', 'chatgpt_storage_error'); }
    });
    this.saveChain = operation; return operation;
  }

  async _json(url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw failure('无法连接 OpenAI，请检查网络后重试。', 'chatgpt_network_error', 502); }
    let raw;
    try { raw = await response.text(); } catch { throw failure('OpenAI 响应读取失败，请重试。', 'chatgpt_network_error', 502); }
    if (raw.length > 2000000) throw failure('OpenAI 响应超出预期大小。');
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw failure('OpenAI 返回了无法解析的响应。'); }
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      if (code === 'invalid_grant') throw failure('登录凭据已失效，请重新登录。', 'chatgpt_invalid_grant', 401);
      throw failure(`OpenAI 请求失败（HTTP ${response.status}），请稍后重试。`, 'chatgpt_remote_error', response.status === 401 ? 401 : 502);
    }
    return data;
  }
  async _discovery() {
    if (this.discovery) return this.discovery;
    const value = await this._json(DISCOVERY);
    if (value.issuer !== ISSUER) throw failure('OpenAI 登录元数据的签发方不匹配。', 'chatgpt_identity_invalid');
    this._trustedAuthUrl(value.jwks_uri);
    if (value.revocation_endpoint) this._trustedAuthUrl(value.revocation_endpoint);
    this.discovery = value; return value;
  }
  _trustedAuthUrl(value) {
    let url; try { url = new URL(value); } catch { throw failure('OpenAI 登录服务地址无效。', 'chatgpt_identity_invalid'); }
    if (url.origin !== ISSUER || url.username || url.password || url.hash) throw failure('OpenAI 登录服务地址不受信任。', 'chatgpt_identity_invalid');
    return url.toString();
  }
  async _verifyIdToken(token, clientId, nonce, expectedSubject) {
    if (!safeString(token) || token.split('.').length !== 3) throw failure('登录身份凭据无效。', 'chatgpt_identity_invalid');
    const parts = token.split('.');
    if (parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw failure('登录身份凭据格式无效。', 'chatgpt_identity_invalid');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
    catch { throw failure('登录身份凭据格式无效。', 'chatgpt_identity_invalid'); }
    if (!['RS256', 'ES256'].includes(header.alg) || !safeString(header.kid, 500) || header.crit) throw failure('登录身份签名算法不受支持。', 'chatgpt_identity_invalid');
    const discovery = await this._discovery(), jwks = await this._json(this._trustedAuthUrl(discovery.jwks_uri));
    const candidates = (Array.isArray(jwks.keys) ? jwks.keys : []).filter(key => key.kid === header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg) && (!key.key_ops || key.key_ops.includes('verify')) && (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
    if (candidates.length !== 1) throw failure('找不到有效的 OpenAI 身份签名密钥。', 'chatgpt_identity_invalid');
    let valid = false;
    try { const key = crypto.createPublicKey({ key: candidates[0], format: 'jwk' }); valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url')); } catch {}
    const seconds = this.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!valid || claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= seconds || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 30)) || (nonce !== undefined && claims.nonce !== nonce) || !safeString(claims.sub, 1000) || (expectedSubject && claims.sub !== expectedSubject)) throw failure('登录身份校验失败，请从共鸣重新发起登录。', 'chatgpt_identity_invalid');
    return claims;
  }
  _tokens(data, previous = null) {
    if (!safeString(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 || (data.refresh_token !== undefined && !safeString(data.refresh_token)) || (data.id_token !== undefined && !safeString(data.id_token))) throw failure('OpenAI 未返回有效的登录凭据。', 'chatgpt_token_invalid');
    const scopes = typeof data.scope === 'string' ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : previous?.scopes || [];
    const credential = { accessToken: data.access_token, refreshToken: data.refresh_token || '', idToken: data.id_token || previous?.idToken || '', scopes, ...(previous?.registration ? { registration: previous.registration } : {}), expiresAt: this.now() + data.expires_in * 1000, savedAt: this.now() };
    this._remember(credential); return credential;
  }
  async _seal(credential) {
    if (!this.vault) return null;
    try { const sealed = await this.vault.seal(JSON.stringify(credential)); if (!safeString(sealed, 200000)) throw new Error('invalid sealed output'); return sealed; }
    catch { throw failure('系统加密存储不可用，请重新打开桌面软件后登录。', 'chatgpt_storage_error'); }
  }

  async start(accountId) {
    if (this.closed) throw failure('连接服务已关闭，请重新打开软件。');
    if (this.pending) throw failure('已有登录正在进行，请先完成或等待它过期。', 'chatgpt_login_pending', 409);
    const account = accountId ? this._account(accountId) : null;
    if (!account && this.accounts.length >= 12) throw failure('最多保存 12 个 ChatGPT 账号。');
    const transaction = { accountId: account?.id || null, clientId: account?.clientId || this.retryClientId || 'dynamic_agent_client', expectedSubject: account?.subject, state: random(), nonce: random(), verifier: random(), startedAt: this.now(), expiresAt: this.now() + this.attemptMs, claimed: false };
    this.pending = transaction; this.error = null;
    this.knownSecrets.add(transaction.verifier);
    const server = http.createServer((request, response) => { this._callback(transaction, request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end('登录未完成，请返回共鸣重试。'); }); });
    server.requestTimeout = 25000; server.headersTimeout = 5000;
    transaction.server = server;
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
    catch { this.pending = null; throw failure('无法启动本地登录回调，请检查端口权限。'); }
    transaction.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    transaction.timer = setTimeout(() => { if (this.pending === transaction) { this.error = '登录已过期，请重新开始。'; this._endAttempt(transaction); } }, this.attemptMs); transaction.timer.unref();
    const url = new URL(AUTHORIZE);
    for (const [key, value] of Object.entries({ client_id: transaction.clientId, ext_agent_host_id: this.hostId, response_type: 'code', redirect_uri: transaction.redirectUri, scope: SCOPES, resource: RESOURCE, state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(transaction.verifier).digest('base64url') })) url.searchParams.set(key, value);
    if (transaction.clientId === 'dynamic_agent_client') url.searchParams.set('agent_name_hint', 'Gongming');
    if (account?.email) url.searchParams.set('login_hint', account.email);
    // The optional id_token_hint is intentionally omitted: this URL is passed
    // to the UI, while all token types must remain in the backend.
    return { authorizationUrl: url.toString() };
  }
  _endAttempt(transaction) {
    clearTimeout(transaction.timer);
    if (this.pending === transaction) this.pending = null;
    transaction.server?.close(); transaction.server?.closeIdleConnections();
  }
  async _callback(transaction, request, response) {
    const answer = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); response.end(text); };
    const expectedUrl = new URL(transaction.redirectUri);
    let url; try { url = new URL(request.url, transaction.redirectUri); } catch { return answer(400, '无效登录回调。'); }
    if (request.method !== 'GET' || request.headers.host !== expectedUrl.host || url.origin !== expectedUrl.origin || url.pathname !== '/auth/callback') return answer(400, '无效登录回调。');
    if (this.pending !== transaction || transaction.claimed || transaction.expiresAt <= this.now()) return answer(409, '此登录已处理或过期，请返回共鸣。');
    const q = url.searchParams;
    if (['state', 'code', 'client_id', 'error'].some(key => q.getAll(key).length > 1) || q.get('state') !== transaction.state) return answer(400, '登录状态不匹配，请返回共鸣重新开始。');
    transaction.claimed = true;
    try {
      if (q.has('error')) throw failure(q.get('error') === 'access_denied' ? '已取消 ChatGPT 登录。' : 'ChatGPT 未完成授权，请重新登录。', 'chatgpt_authorization_denied');
      const clientId = q.get('client_id') || (transaction.clientId !== 'dynamic_agent_client' ? transaction.clientId : '');
      if (!issuedClient(clientId) || (transaction.clientId !== 'dynamic_agent_client' && clientId !== transaction.clientId)) throw failure('登录回调的账号注册不匹配，请重新登录。', 'chatgpt_identity_invalid');
      const code = q.get('code'); if (!safeString(code)) throw failure('登录回调缺少授权码，请重新开始。');
      this.knownSecrets.add(code);
      let data;
      try { data = await this._json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE }).toString() }); }
      catch (error) { if (error.code === 'chatgpt_invalid_grant' && !transaction.accountId) this.retryClientId = clientId; throw error; }
      const credential = this._tokens(data), identity = await this._verifyIdToken(data.id_token, clientId, transaction.nonce, transaction.expectedSubject);
      if (this.closed || this.pending !== transaction) throw failure('登录已取消，请重新开始。');
      const same = this.accounts.find(item => item.clientId === clientId);
      if (same && same.subject !== identity.sub) throw failure('此注册已关联其他身份，登录未保存。', 'chatgpt_identity_invalid');
      const account = transaction.accountId ? this._account(transaction.accountId) : same || { id: `chatgpt-${crypto.randomUUID()}`, clientId, subject: identity.sub, issuer: ISSUER, models: [] };
      credential.registration = { clientId, subject: identity.sub, issuer: ISSUER };
      const sealed = await this._seal(credential), email = typeof identity.email === 'string' ? identity.email.slice(0, 320) : '';
      const next = { ...account, email, label: account.label || `${email || 'ChatGPT 账号'} · ${account.id.slice(-6)}`, planEnabled: credential.scopes.includes(PLAN_SCOPE), sealed };
      await this._lock(account.id, async () => {
        if (this.closed || this.pending !== transaction || this.blocked.has(account.id)) throw failure('登录已取消，请重新开始。');
        const index = this.accounts.findIndex(item => item.id === account.id), old = index < 0 ? null : this.accounts[index], oldCredential = this.credentials.get(account.id);
        if (index < 0) this.accounts.push(next); else this.accounts[index] = next;
        this.credentials.set(account.id, credential); this.blocked.delete(account.id);
        try { await this._save(); } catch (error) { if (old) this.accounts[index] = old; else this.accounts = this.accounts.filter(item => item.id !== account.id); if (oldCredential) this.credentials.set(account.id, oldCredential); else this.credentials.delete(account.id); throw error; }
      });
      this.retryClientId = null;
      if (next.planEnabled) { try { await this.models(next.id); } catch { this.error = 'ChatGPT 已登录，但模型列表暂时无法读取，请稍后刷新。'; } }
      else this.error = '已登录 ChatGPT，但尚未授予使用套餐的权限，请重新授权。';
      answer(200, next.planEnabled ? 'ChatGPT 登录成功。请关闭此页面，返回共鸣选择模型。' : 'ChatGPT 账号已登录，但尚未授权套餐使用。请返回共鸣查看。');
    } catch (error) { this.error = error instanceof HttpError ? error.message : 'ChatGPT 登录未完成，请重试。'; answer(error.status || 400, this.error); }
    finally { this._endAttempt(transaction); }
  }

  async accessToken(accountId) {
    if (this.closed) throw failure('连接服务已关闭，请重新打开软件。', 'chatgpt_login_required', 401);
    return this._lock(accountId, async () => {
      const account = this._account(accountId); let credential = this.credentials.get(accountId);
      if (this.blocked.has(accountId) || !credential) throw failure('此 ChatGPT 账号需要重新登录。', 'chatgpt_login_required', 401);
      if (!credential.scopes.includes(PLAN_SCOPE)) throw failure('此账号尚未授权使用 ChatGPT 套餐。', 'chatgpt_plan_permission_required', 403);
      if (credential.expiresAt > this.now() + 60000) return credential.accessToken;
      if (!credential.refreshToken) { if (credential.expiresAt > this.now()) return credential.accessToken; throw failure('ChatGPT 登录已过期，请重新登录。', 'chatgpt_login_required', 401); }
      let data;
      try { data = await this._json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: credential.refreshToken, resource: RESOURCE }).toString() }); }
      catch (error) { if (error.code === 'chatgpt_invalid_grant') { this.credentials.delete(accountId); delete account.sealed; await this._save(); this.error = 'ChatGPT 登录已失效，请重新登录此账号。'; } throw error; }
      let next;
      try {
        next = this._tokens(data, credential);
        if (!next.refreshToken) throw failure('刷新响应缺少替换凭据，请重新登录 ChatGPT。', 'chatgpt_token_invalid', 401);
        if (data.id_token) await this._verifyIdToken(data.id_token, account.clientId, undefined, account.subject);
      } catch (error) {
        // A successful token response may have consumed the old refresh token,
        // even when its replacement fails local validation. Do not replay it.
        this.credentials.delete(accountId); delete account.sealed; await this._save();
        this.error = 'ChatGPT 刷新身份校验未通过，请重新登录此账号。'; throw error;
      }
      // A rotating refresh token cannot be rolled back. Keep only the newest
      // set in memory if encrypted persistence fails; never retry the old one.
      this.credentials.set(accountId, next); account.planEnabled = next.scopes.includes(PLAN_SCOPE); delete account.sealed;
      try { account.sealed = await this._seal(next); await this._save(); }
      catch (error) { this.error = 'ChatGPT 登录已刷新，但未能保存，仅本次启动可用；退出前请检查本地存储。'; await this._save().catch(() => {}); throw error; }
      if (!account.planEnabled) throw failure('ChatGPT 套餐权限已变化，请重新授权。', 'chatgpt_plan_permission_required', 403);
      return next.accessToken;
    });
  }
  _cleanModels(items, saved = false) {
    if (!Array.isArray(items)) return [];
    const models = [], seen = new Set();
    for (const model of items.slice(0, 500)) {
      const id = saved ? model?.id : model?.slug, name = saved ? model?.name : model?.display_name;
      if ((!saved && model?.visibility !== 'list') || !safeString(id, 200) || !safeString(name, 300) || seen.has(id)) continue;
      seen.add(id); models.push({ id, name });
    }
    return models;
  }
  async models(accountId) {
    this._account(accountId); const token = await this.accessToken(accountId);
    const response = await this._json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(response.models)) throw failure('未能读取此账号的 ChatGPT 模型列表，请重试。', 'chatgpt_models_invalid');
    if (this.closed || this.blocked.has(accountId) || this.credentials.get(accountId)?.accessToken !== token) throw failure('账号连接已变化，请重新刷新模型列表。', 'chatgpt_login_required', 409);
    const account = this._account(accountId); account.models = this._cleanModels(response.models); await this._save(); return structuredClone(account.models);
  }
  async logout(accountId) {
    if (this.closed) throw failure('连接服务已关闭，请重新打开软件。');
    this._account(accountId); this.blocked.add(accountId);
    if (this.pending?.accountId === accountId) this._endAttempt(this.pending);
    return this._lock(accountId, async () => {
      const account = this._account(accountId), credential = this.credentials.get(accountId);
      let revocationConfirmed = false;
      try {
        if (credential?.refreshToken) {
          const discovery = await this._discovery(), endpoint = this._trustedAuthUrl(discovery.revocation_endpoint);
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString(), redirect: 'error', signal: AbortSignal.timeout(10000) });
              if (response.status === 200) { revocationConfirmed = true; break; }
              if (response.status < 500) break;
            } catch {}
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
          }
        }
      } catch {}
      this.credentials.delete(accountId); delete account.sealed; account.models = [];
      try { await this._save(); } finally { this.blocked.delete(accountId); }
      const warning = revocationConfirmed ? null : '已退出本地账号，但无法确认远程撤销。可在 ChatGPT 设置中断开共鸣的访问。';
      this.error = warning; return { revocationConfirmed, warning };
    });
  }
  async close({releaseOwner=true}={}) { this.closed = true; if (this.pending) this._endAttempt(this.pending); await Promise.allSettled([...this.sessionLocks.values()]); await this.saveChain.catch(() => {}); if(releaseOwner)await this._releaseOwner(); }
}
