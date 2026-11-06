-- `/all` 走的是 listedCondition：visibility='public' AND (NOT selected OR visible_after<=now)
-- AND workflowReadyCondition() AND chineseCopyCondition()。workflowReadyCondition 里带
-- `body_mode='full'`，但**没有 `eligible`** —— 0111 那条部分索引的谓词是
-- `visibility='public' and eligible and body_mode='full'`，查询并不蕴含 eligible，
-- 规划器用不上它，于是 `/all` 仍然对 306 MB 的 publications 做并行全表扫描。
--
-- 2026-11-07 02:2x 现场：`/all` 连续 503（11.3 s / 1.5 s / 9.9 s），api 日志是
-- `PublicReadBusyError … path=/api/site/timeline ms=19399`。补一条只带静态条件、不带
-- eligible 的部分索引，让 LIMIT 40 能顺着 timeline_at 倒序走索引，EXISTS 只作为过滤。
create index concurrently if not exists publications_all_page_idx
  on publications (timeline_at desc, article_id)
  where visibility = 'public' and body_mode = 'full';
