-- pgboss 的取作业语句在这台慢盘上是最大的读放大源。
--
-- 2026-11-16 现场：`pg_stat_user_tables` 里 `pgboss.job_common` 只有 142,349 行，
-- 却有 `seq_scan 3,655 / seq_tup_read 488,912,279` —— 平均每次取作业扫掉 13 万行。
-- 原因是 pgboss 的 `fetch()` 形如
--   WITH next AS (SELECT j.id FROM pgboss.job_common j
--                 WHERE j.name=$1 AND j.state<'active' AND j.start_after<=now()
--                 ORDER BY j.priority DESC, j.created_on, j.id
--                 LIMIT $2 FOR UPDATE SKIP LOCKED)
-- 而现有索引里没有一个覆盖 `(name, state, start_after, priority, created_on)` 这套顺序，
-- 每个执行器每秒一次的轮询就变成一次全表扫。
--
-- 只能条件建：全新库上 pgboss 的 schema 要等它自己启动时才出现，这时候还没得建。
-- 那一步由 worker 启动时的 `ensureFetchIndex()`（packages/backend/src/jobs/fetch-index.ts）补上。
DO $$
BEGIN
  IF to_regclass('pgboss.job_common') IS NULL THEN
    RAISE NOTICE 'pgboss.job_common 还不存在，取作业索引留给 worker 启动时补';
  ELSE
    CREATE INDEX IF NOT EXISTS job_common_fetch_idx
      ON pgboss.job_common (name, state, start_after, priority DESC, created_on);
  END IF;
END $$;
