// A small keyed cache for one process's most-requested read responses.
//
// Why it exists: `/api/site/pool` is the list every `/all` reader (and every crawler combination of
// category × tag × date) asks for, and one page of it costs a few hundred milliseconds of Postgres
// work even when nothing changed since the previous request. The edge keeps a copy for 5 minutes, but
// a cold URL — and every request from the web server's own SSR pass — still paid for the query.
//
// The contract is deliberately small and boring:
//   · inside `freshMs` the value is returned as-is;
//   · between `freshMs` and `staleMs` the value is still returned (caller decides whether to refresh
//     in the background), because a list that is forty seconds old is a better answer than a reader
//     waiting on a busy database;
//   · past `staleMs` the entry is gone.
// Keys are evicted oldest-written-first once `maxEntries` is reached, so a crawler walking page
// numbers cannot grow the map without bound.

export interface MicroCacheEntry<T> {
  data: T;
  ageMs: number;
  fresh: boolean;
  stale: boolean;
}

export interface MicroCacheOptions {
  freshMs: number;
  staleMs: number;
  maxEntries?: number;
}

export class MicroCache<T> {
  private readonly rows = new Map<string, { data: T; at: number }>();
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;

  constructor(opts: MicroCacheOptions) {
    if (!(opts.freshMs >= 0)) throw new Error("micro-cache: freshMs must be a number >= 0");
    if (!(opts.staleMs >= opts.freshMs)) throw new Error("micro-cache: staleMs must be >= freshMs");
    this.freshMs = opts.freshMs;
    this.staleMs = opts.staleMs;
    this.maxEntries = Math.max(1, opts.maxEntries ?? 100);
  }

  /** The entry for `key` when it is younger than `staleMs`, with its age and freshness. */
  read(key: string, now = Date.now()): MicroCacheEntry<T> | null {
    const row = this.rows.get(key);
    if (!row) return null;
    const ageMs = now - row.at;
    if (ageMs > this.staleMs) {
      this.rows.delete(key);
      return null;
    }
    return { data: row.data, ageMs, fresh: ageMs <= this.freshMs, stale: ageMs > this.freshMs };
  }

  /**
   * Store a value. Re-writing a key moves it to the newest position (Map keeps insertion order),
   * so the eviction below always drops the key that was written longest ago.
   */
  write(key: string, data: T, now = Date.now()): void {
    this.rows.delete(key);
    this.rows.set(key, { data, at: now });
    while (this.rows.size > this.maxEntries) {
      const oldest = this.rows.keys().next();
      if (oldest.done) break;
      this.rows.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  clear(): void {
    this.rows.clear();
  }

  get size(): number {
    return this.rows.size;
  }
}
