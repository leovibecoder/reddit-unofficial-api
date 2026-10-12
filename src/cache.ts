// TTL cache for GET listings. Per PRD 5.1: feed 120s, inbox 30s, post 300s.
// Any write operation clears the whole cache — writes are rare relative to
// reads, and full clear is trivially safe at this size.

export class TTLCache {
  private store = new Map<string, { value: any; expires: number }>();

  private key(path: string, params: Record<string, string>): string {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    return `${path}?${sorted}`;
  }

  get(path: string, params: Record<string, string> = {}): any | undefined {
    const k = this.key(path, params);
    const hit = this.store.get(k);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(k);
      return undefined;
    }
    return hit.value;
  }

  set(path: string, params: Record<string, string>, value: any, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    this.store.set(this.key(path, params), { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
