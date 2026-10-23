import { sql, type Tx } from "../db.ts";

export interface StatisticStatus {
  state: "ready" | "unavailable";
  asOf: string | null;
  message?: string;
}
export interface StatisticResult<T> { rows: T; status: StatisticStatus }

/** Cache only read-side statistics; settings and model switches never pass through this cache.
 * Rejections get a short cooldown as well, so a refresh storm cannot restart a timed-out scan. */
export function statisticReader<T>(read: () => PromiseLike<readonly T[]>, empty: () => T[], now = Date.now) {
  let cached: { until: number; value: StatisticResult<T[]> } | undefined;
  let pending: Promise<StatisticResult<T[]>> | undefined;
  return function get(): Promise<StatisticResult<T[]>> {
    if (cached && cached.until > now()) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = Promise.resolve().then(read).then(rows => {
      const value: StatisticResult<T[]> = { rows: [...rows], status: { state: "ready", asOf: new Date(now()).toISOString() } };
      cached = { until: now() + 30_000, value };
      return value;
    }, () => {
      // Never turn missing measurements into a successful zero, and never expose SQL/error details.
      const value: StatisticResult<T[]> = { rows: empty(), status: {
        state: "unavailable", asOf: null, message: "统计暂时不可用（查询超时或数据库繁忙），请稍后刷新。",
      } };
      cached = { until: now() + 5_000, value };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

/** A database-side deadline actually stops the scan after an HTTP caller has gone away.
 * SET LOCAL keeps these limits out of worker writes and other pooled connections. */
export function modelStatisticRead<T>(read: (db: Tx) => Promise<T>, timeoutMs = 5_000): Promise<T> {
  return sql.begin("READ ONLY", async db => {
    await db`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true),
                    set_config('lock_timeout', '250ms', true),
                    set_config('max_parallel_workers_per_gather', '0', true)`;
    return read(db);
  }) as Promise<T>;
}
