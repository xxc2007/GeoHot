import { sql, type Tx } from "../db.ts";

/** A statement deadline on an admin read reached the reader as a spinner with no end: the scan
 *  kept running in the pool after the HTTP caller had gone away. A database-side deadline actually
 *  stops it. READ ONLY additionally guarantees a future write function wrapped here by mistake
 *  fails loudly instead of silently succeeding, and SET LOCAL keeps these limits out of worker
 *  writes and other pooled connections (same shape as model-statistics-read.ts:38-45; this one is
 *  deliberately separate — the statistics read carries its own cache/cooldown layer, admin read
 *  pages stay uncached — but kept line-identical so they can merge later).
 *
 *  The default deadline matches the 8 seconds the reader-side statements use: admin listings sit
 *  in the same pool as reader reads, so a tighter deadline turned an ordinary slow minute into a
 *  503 on /admin/sources (observed 2026-11-05 01:17 in production). Still bounded, still READ ONLY. */
export function adminRead<T>(read: (db: Tx) => Promise<T>, timeoutMs = 8_000): Promise<T> {
  return sql.begin("READ ONLY", async db => {
    await db`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true),
                    set_config('lock_timeout', '250ms', true),
                    set_config('max_parallel_workers_per_gather', '0', true)`;
    return read(db);
  }) as Promise<T>;
}

/** A timed-out admin read is a "refresh later", not a server fault: map the cancellation to a
 *  plain message the admin handler already routes through its logged 500 path. */
export async function adminReadOrBusy<T>(
  read: (db: Tx) => Promise<T>,
  timeoutMs = 8_000,
  attempts: 1 | 2 = 2,
): Promise<T> {
  const busyCode = (error: unknown): string => (error as { code?: string }).code ?? "";
  const busy = (error: unknown): boolean => ["57014", "55P03"].includes(busyCode(error));
  try {
    return await adminRead(read, timeoutMs);
  } catch (error) {
    // 包装器自己设的 lock_timeout 报 55P03，和 statement_timeout 的 57014 是同一件事：
    // 只认前者会让锁等待也冒成 500（model-label-backfill.ts 早就同时识别两者了）。
    if (attempts === 1 || !busy(error)) {
      if (attempts === 1 && busy(error)) throw busyError();
      throw error;
    }
    // 慢盘上的一次抖动通常是几十秒级别：第一次超时后再给一次更宽的机会，
    // 后台页面因此在磁盘繁忙时「慢一点但出得来」，而不是直接 503
    //（2026-11-15 真浏览器巡检 11/14，/admin/settings 与 /admin/audit 都是这一条）。
    try {
      return await adminRead(read, Math.max(timeoutMs, 12_000));
    } catch (again) {
      if (busy(again)) throw busyError();
      throw again;
    }
  }
}

function busyError(): Error {
  return Object.assign(new Error("后台读取暂时超时，请稍后刷新"), { code: "ADMIN_READ_TIMEOUT" });
}
