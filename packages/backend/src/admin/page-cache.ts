import { MicroCache } from "../lib/micro-cache.ts";

/**
 * 后台页面用的「先给旧值、后台再算」缓存。
 *
 * 2026-11-16 现场：主库那块盘 random read 慢到单条聚合几十秒，`/admin/server`、`/admin/models`、
 * `/admin/settings`、`/admin/audit` 在浏览器巡检里直接 503（`adminReadOrBusy` 两次都超时）。
 * 这些页面都是「人看一眼」的数据，30–120 秒的陈旧完全可以接受；真正不能接受的是转圈。
 *
 * 语义与 `apps/api/src/routes/admin.ts` 的用量总览一致：
 *   1. 新鲜（`freshMs` 内）→ 直接给；
 *   2. 过期但还在 `staleMs` 内 → 先给旧值，后台重算；
 *   3. 没有旧值 → await；失败时若刚好有别的请求写进来了旧值，也给；
 *   4. 同一个 key 并发只算一次（`pending`）。
 */
export interface PageCacheOptions {
  freshMs?: number;
  staleMs?: number;
  maxEntries?: number;
}

const DEFAULT_FRESH_MS = 30_000;
const DEFAULT_STALE_MS = 15 * 60_000;

const caches = new Map<string, MicroCache<unknown>>();
const pending = new Map<string, Promise<unknown>>();

function cacheFor(scope: string, options: PageCacheOptions): MicroCache<unknown> {
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const maxEntries = options.maxEntries ?? 64;
  const signature = `${freshMs}/${staleMs}/${maxEntries}`;
  const key = `${scope}#${signature}`;
  const held = caches.get(key);
  if (held) return held;
  const made = new MicroCache<unknown>({ freshMs, staleMs, maxEntries });
  caches.set(key, made);
  return made;
}

/** 取缓存里的值；`stale` 为真表示「先给旧值，正在后台重算」。 */
export function peekPage<T>(scope: string, key: string, options: PageCacheOptions = {}): { data: T; stale: boolean } | null {
  const hit = cacheFor(scope, options).read(key);
  if (!hit) return null;
  return { data: hit.data as T, stale: hit.stale };
}

export async function cachePage<T>(
  scope: string,
  key: string,
  load: () => Promise<T>,
  options: PageCacheOptions = {},
): Promise<T> {
  const cache = cacheFor(scope, options);
  const slot = `${scope}#${key}`;
  const hit = peekPage<T>(scope, key, options);

  const refresh = (): Promise<T> => {
    const running = pending.get(slot) as Promise<T> | undefined;
    if (running) return running;
    const run = load()
      .then((data) => {
        cache.write(key, data);
        return data;
      })
      .finally(() => pending.delete(slot));
    pending.set(slot, run as Promise<unknown>);
    return run;
  };

  if (hit && !hit.stale) return hit.data;
  if (hit) {
    void refresh().catch(() => {});
    return hit.data;
  }
  try {
    return await refresh();
  } catch (error) {
    const again = peekPage<T>(scope, key, options);
    if (again) return again.data;
    throw error;
  }
}

/** 仅供测试：丢掉所有缓存与在飞请求，避免用例之间互相污染。 */
export function resetPageCaches(): void {
  caches.clear();
  pending.clear();
}
