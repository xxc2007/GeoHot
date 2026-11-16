import { sql } from "../db.ts";

/**
 * 取作业索引。
 *
 * 2026-11-16 现场：`pgboss.job_common` 142,349 行，却累积了 `seq_scan 3,655 / seq_tup_read 488,912,279`
 * —— 每个执行器每秒一次的取作业都在整表扫（平均 13 万行/tick），是这块慢盘上最大的读放大。
 * 迁移里只能条件建（全新库上 pgboss 的 schema 要等它自己启动时才出现），所以 worker 起来之后再补一次。
 * 幂等：已经有了就来一次 `to_regclass` 判断，什么都不做。
 */
export async function ensureFetchIndex(): Promise<"present" | "created" | "skipped"> {
  const [row] = await sql<{ has: boolean }[]>`
    SELECT to_regclass('pgboss.job_common') IS NOT NULL AS has
  `;
  if (!row?.has) return "skipped";
  const [before] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('pgboss.job_common_fetch_idx') IS NOT NULL AS exists
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS job_common_fetch_idx
      ON pgboss.job_common (name, state, start_after, priority DESC, created_on)
  `;
  return before?.exists ? "present" : "created";
}
