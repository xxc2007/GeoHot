-- 读者面首屏的取数走 `publications` 上 `timeline_at DESC` 的顺序，但门里还挂着两条 EXISTS
-- （`sources.site_fulltext` 与 `article_workflow_readiness`），规划器没有索引可裁剪，只能对 306 MB 的
-- `publications` 做并行全表扫描再排序 —— 2026-11-06 生产实测这条查询跑了 266 秒，同机 `home` 稳定 3–13 秒。
--
-- 这个部分索引把「读者可能看到的那一批」缩到 1.5 MB：公开展示、过了池门、且已经拿到完整正文的 25,180 行。
-- 建立后同样的查询 `Index Scan using publications_reader_page_idx`，58 行索引项即收工，实测 3.8 ms。
-- 只覆盖静态条件（visibility / eligible / body_mode），workflow readiness 仍由 EXISTS 逐行判定 —— 那是
-- 会变的事实，放进部分索引的谓词会让索引随每次分析完成而失效。
CREATE INDEX IF NOT EXISTS publications_reader_page_idx
  ON publications (timeline_at DESC, article_id)
  WHERE visibility = 'public' AND eligible AND body_mode = 'full';
