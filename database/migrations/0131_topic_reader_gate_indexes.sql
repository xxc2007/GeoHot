-- 2026-11-23 生产现场：/topics/usgs 与 /en/topics/usgs 都是 503，日志
--   path:/api/site/topics/usgs ms:16521/27146 kind:PublicReadBusyError
-- 同一条读在 psql 里 EXPLAIN (ANALYZE, BUFFERS) 是 10.3–16.1 s：
--   1) 主题详情的成员门扫 `publications_selected_zh_anchor_idx`（(visible_after) INCLUDE
--      sort_at/story_id/fact_id/article_id），1.67 万条精选行逐条回表取 title/summary/
--      source_id/revision/analysis_id，1.1 万次读盘；
--   2) 外层 `WHERE p.article_id IN (SELECT … page)` 的半连接不能交换内外侧，规划器把 13.3 万行
--      publications（再连 articles/translations/stories）放在外侧做哈希，再问哪 20 个 id 要——
--      光这一半就 12–16 s、24 MB 临时文件。
--
-- 查询侧已改成：精选语境下 `visible_after <= now`（与 `NOT selected OR …` 等价）+ `FROM page
-- JOIN publications p`（见 items.ts 的 selectedReleaseGateCondition 与 topics.ts 的
-- loadTopicPage）。这条迁移补上让前者走索引、且全程 index-only 的两条部分索引。
--
-- 谓词里的 `title ~ '[一-鿿]'` 与 btrim/label 两条正则就是读取层 `chineseCopyCondition` 的
-- 静态部分（packages/contracts/src/copy.ts）；放进谓词后，标题目录本身不再需要回表。改成
-- `CREATE INDEX`（不是 CONCURRENTLY）：scripts/migrate.ts 每个迁移一个事务，CONCURRENTLY
-- 在事务里不可用（0127/0129 同样处理）。`IF NOT EXISTS` 保证可重复执行。

CREATE INDEX IF NOT EXISTS publications_selected_gate_idx
  ON publications (timeline_at DESC, article_id)
  INCLUDE (revision, analysis_id, source_id, visible_after, tags)
  WHERE visibility = 'public'
    AND selected
    AND body_mode = 'full'
    AND title ~ '[一-鿿]'
    AND btrim(title) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$'
    AND (summary IS NULL OR btrim(summary) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$');

-- `workflowReadyCondition` 的正文就绪探针：读的是 article_workflow_readiness 的
-- (revision, analysis_id, ready, body_quality_status, policy_version)，pkey 只覆盖 article_id，
-- 每条精选行都要回表一次（2026-11-23 实测 8,776 次/门扫）。这条窄部分索引让探针变成 index-only，
-- 谓词与读取层的 ready/quality/policy 三项一字不差；`revision`/`analysis_id` 放进 INCLUDE。
CREATE INDEX IF NOT EXISTS article_workflow_readiness_reader_idx
  ON article_workflow_readiness (article_id)
  INCLUDE (revision, analysis_id)
  WHERE ready AND body_quality_status = 'ok' AND policy_version >= 3;