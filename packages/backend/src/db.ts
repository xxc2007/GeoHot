import postgres from "postgres";
import { config } from "./config.ts";
import { poolSize } from "./jobs/worker-role.ts";

// int8 and numeric come back as numbers: ids and scores in this schema stay far below 2^53.
const numberType = (oid: number) => ({
  to: oid,
  from: [oid],
  serialize: (value: unknown) => String(value),
  parse: (value: string) => Number(value),
});

export const sql = postgres(config.databaseUrl, {
  max: poolSize(process.env.DATABASE_POOL_MAX, "DATABASE_POOL_MAX", 10),
  // Keep connections through quiet minutes: a reconnect costs a SCRAM exchange on the next request.
  // 但「一直留着」有代价：云主机那条链路上空闲太久的 socket 会被中途掐掉，池子拿到一条死连接就报
  // `timeout exceeded when trying to connect`（2026-11-05 02:09 让 worker 整个进程崩过一次，01:xx
  // 也打断过 cron.sources.mp-reconcile）。所以留得比闲时短、并给连接一个最大寿命：到期由客户端主动换新，
  // 不等内核替我们发现对端已经没了。
  idle_timeout: 120,
  max_lifetime: 30 * 60,
  connect_timeout: 10,
  onnotice: () => {},
  // Prepared statements keep PostgreSQL's plan cache: planning a detail read took longer than running
  // it. Searches plan every execution instead (withCustomPlans). JIT compilation costs more than
  // these short queries ever run.
  //
  // `lock_timeout`：服务器在 postgresql.auto.conf 里设了全局 2 秒。那是给**读者**定的上限——
  // 一个读者等不到行锁就该早点回去（publication/read-budget.ts 另外还会收到 1.5 秒）；
  // 但后台的咨询锁是**排队**用的：同一个 service 的预算判定、同一批素材的身份归并本来就该一个接一个。
  // 2 秒把排队当故障，2026-11-06 13:00 起每小时 350–815 篇带着 `canceling statement due to lock timeout`
  // 掉回重试，槽位从 1 加到 13 而出口从 750/h 掉到 300/h。所以在会话级把它放到 15 秒，
  // 真死锁仍由 deadlock_timeout 兜底，而读者那条路被 read-budget.ts 的 SET LOCAL 继续钉在 1.5 秒。
  connection: { jit: "off", lock_timeout: 15_000 },
  types: {
    int8: numberType(20),
    numeric: numberType(1700),
  },
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

/**
 * Runs queries with plans made for their actual values. A cached generic plan cannot tell a
 * two-character search term (no usable trigram) from a longer one and would scan the whole trigram
 * index, so every search goes through here.
 */
export function withCustomPlans<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    return fn(tx);
  }) as Promise<T>;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** First row of a query that always returns one (aggregates). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row");
  return row;
}
