import {randomBytes, timingSafeEqual} from 'node:crypto';

// A capability for one backend lifetime. Never stored in the workspace or sent
// by an unauthenticated HTTP endpoint. Desktop bootstraps over the owned IPC pipe.
export function createApiSession() {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  return Object.freeze({
    token,
    accepts(request) {
      const value = request.headers.authorization;
      if (typeof value !== 'string') return false;
      const actual = Buffer.from(value);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  });
}

// Preview capabilities expose only one document, never the workspace API.
// HTTP CSP sandbox gives the document an opaque origin even if opened directly.
export class PreviewStore {
  constructor({ttl = 300000, maxEntries = 16} = {}) {
    this.ttl = ttl;
    this.maxEntries = maxEntries;
    this.items = new Map();
  }
  create(html, scripts = false) {
    if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) {
      throw Object.assign(new Error('预览内容无效或超过 2 MB'), {status: 400});
    }
    for (const [id, item] of this.items) if (item.expires <= Date.now()) this.items.delete(id);
    while (this.items.size >= this.maxEntries) this.items.delete(this.items.keys().next().value);
    const id = randomBytes(24).toString('hex');
    this.items.set(id, {html, scripts: scripts === true, expires: Date.now() + this.ttl});
    return `/preview/${id}`;
  }
  get(id) {
    const item = this.items.get(id);
    if (!item || item.expires <= Date.now()) { this.items.delete(id); return null; }
    return item;
  }
}

export const workspaceCsp = "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const previewCsp = scripts => `default-src 'none'; sandbox${scripts ? ' allow-scripts' : ''}; script-src ${scripts ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
