-- 读者面的计数与列表在 891MB 的机器上会整表扫堆：publications 的堆 111MB（十万行，正文列很大），
-- 而 `count(*) … WHERE visibility='public'` 与 `(NOT selected OR visible_after<=now)` 这两处没有可用的窄索引，
-- 冷缓存下要读几十兆页，2026-11-05 18:52 的现场是同一屏出现 8 秒超时、pg_stat_activity 里两条 17–20 秒的读。
--
-- 这里补三个「只带 article_id 的窄局部索引」，计数可以走 index-only scan（VACUUM 之后可见性图才全绿）；
-- 不改变任何语义，也不动既有的排序索引。
CREATE INDEX IF NOT EXISTS publications_public_id_idx
  ON publications (article_id) WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS publications_not_withdrawn_id_idx
  ON publications (article_id) WHERE visibility <> 'withdrawn';

CREATE INDEX IF NOT EXISTS publications_unselected_id_idx
  ON publications (article_id) WHERE visibility = 'public' AND NOT selected;