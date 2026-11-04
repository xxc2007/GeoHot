import { sql, type Tx } from "../db.ts";
import { CapacityExceeded, CapacityGate } from "../lib/capacity.ts";

export class PublicReadBusyError extends Error {
  readonly retryAfter = 2;
}

// Heavy, cold public aggregate reads share a small slot pool. 2026-11-04：原来是 (2, 0)，
// 而首页一次就要并发 3 个请求（timeline / calendar / pool，其中两个都走这里），
// 一个访客就能把 2 个槽占满、queueLimit=0 让第二个访客直接 503。
// 现在给 4 个槽 + 8 个排队位：排队有界，且「一个访客吃掉全部槽位」不再成立。
const aggregates = new CapacityGate(4, 8);
export async function withPublicRead<T>(read: (db: Tx) => Promise<T>, timeoutMs = 8000, customPlan = false): Promise<T> {
  try {
    return await aggregates.run(() => sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      // 这两条不改变结果，只降低「一个慢查询把整机拖住」的概率：
      // 锁等 1.5 秒就放弃（读者宁可拿到 503 也不要等 8 秒），并行工作者一律不派（这台机器只有 2 vCPU）。
      await tx`SELECT set_config('lock_timeout', '1500', true)`;
      await tx`SELECT set_config('max_parallel_workers_per_gather', '0', true)`;
      // The anchor partial index needs actual filter values while sharing this same bounded transaction.
      if (customPlan) await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
      return read(tx);
    }) as Promise<T>);
  } catch (error) {
    if (error instanceof CapacityExceeded || (error as { code?: string }).code === "57014") {
      throw new PublicReadBusyError("Public aggregate reads are temporarily busy");
    }
    throw error;
  }
}
