-- 分析队列的领取（`packages/backend/src/jobs/content.ts:324` 的 `WITH eligible AS MATERIALIZED`）按
-- `processing_state='new'` 取候选，再按 `created_at / processing_queued_at / processing_retry_at` 过滤，
-- 最后按 `discovered_at / timeline_at / backfill_reason` 排序。既有的 `articles_processing_idx` 只带
-- 前两列，其余六列每次都要回堆取 —— 13,292 条 'new' 散在 1 GB 的 `articles` 里，在 891 MB、swap 常年
-- 800 MB 的机器上就是 84 秒的随机读（2026-11-06 生产实测，`pg_stat_activity` 里 `wait_event_type=IO`）。
--
-- 覆盖索引把这六列搬进索引，领取变成 index-only scan。只覆盖 `processing_state='new'`：'analyzed' 的
-- 74k 行永远不走这条路，带上它们只会让索引白白变大。
CREATE INDEX IF NOT EXISTS articles_new_claim_cover_idx
  ON articles (created_at, id)
  INCLUDE (processing_queued_at, processing_retry_at, discovered_at, timeline_at, backfill_reason)
  WHERE processing_state = 'new';
