// Memory-only LRU for JSON model results. Both size and lifetime are bounded;
// callers receive a detached object so later task mutations cannot alter hits.
export class ResultCache {
  constructor({maxEntries = 128, maxBytes = 8 * 1024 * 1024, ttlMs = 15 * 60 * 1000, clock = Date.now} = {}) {
    for (const value of [maxEntries, maxBytes, ttlMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Cache limits must be positive integers');
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entries = new Map();
    this.bytes = 0;
  }
  get size() { this.prune(); return this.entries.size; }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }
  prune() {
    const now = this.clock();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.delete(key);
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.clock()) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return JSON.parse(entry.json);
  }
  set(key, value) {
    this.prune();
    this.delete(key);
    const json = JSON.stringify(value);
    if (json === undefined) return false;
    const bytes = Buffer.byteLength(String(key)) + Buffer.byteLength(json);
    if (bytes > this.maxBytes) return false;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, {json, bytes, expires:this.clock() + this.ttlMs});
    this.bytes += bytes;
    return true;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
