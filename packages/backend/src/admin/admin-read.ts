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
export async function adminReadOrBusy<T>(read: (db: Tx) => Promise<T>, timeoutMs = 8_000): Promise<T> {
  try {
    return await adminRead(read, timeoutMs);
  } catch (error) {
    if ((error as { code?: string }).code === "57014") {
      throw Object.assign(new Error("后台读取暂时超时，请稍后刷新"), { code: "ADMIN_READ_TIMEOUT" });
    }
    throw error;
  }
}
