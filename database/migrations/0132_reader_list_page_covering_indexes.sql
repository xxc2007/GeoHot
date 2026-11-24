-- 2026-11-24 生产现场：/geohot/all、/geohot/en/all 间歇 503，/api/site/pool 的
-- EXPLAIN (ANALYZE, BUFFERS) 在 13.3 万行 publications 上分成两段：
--   1) page CTE（`listedCondition` + eligible + ORDER BY timeline_at DESC LIMIT 40）走
--      `publications_reader_page_idx` 的 Bitmap Heap Scan，12,387 个堆页、2.4 秒——索引里没有
--      selected/visible_after/source_id/revision/analysis_id，门只能逐行回表；而且规划器把
--      readiness 的 EXISTS 去相关成哈希连接后估计只剩 1 行，于是把 2.8 万行全连完再排序，
--      LIMIT 停不下来；
--   2) 外层 `WHERE p.article_id IN (SELECT … page)` 把 133k 行 publications 连同
--      articles/translations/stories 一起哈希，只为拿 40 个 id（8.6–11 秒、24 MB 临时文件）。
--      `pool.ts` 已改成 `FROM page pg JOIN publications p`（与 0131 的主题页同一写法）。
--
-- 这里补的两对 covering 部分索引，让第 1 段沿 timeline 顺序做 index-only scan，门与文案正则
-- 都在索引里判定，取满 40 行就停。谓词与读取层一字不差：
--   · `chineseCopyCondition`（items.ts）的静态部分：`title ~ '[一-鿿]'` 与 btrim/label 两条正则；
--   · `englishListGate` 的 `strict + parity` 分支（items.ts）：英文标题、摘要非空且英文写于当前
--     `revision`。这是读取层的默认策略；本机 .env 目前显式设了 `ENGLISH_TEXT=fallback`
--     （/en 与 /zh 同一批成员），那两条 en 索引在这台机器上不会被选中——它们留给切到 strict 的
--     部署（默认值），体积很小（32 kB / 16 kB），写放大可忽略；切到 `ENGLISH_MEMBERSHIP=english`
--     时 /en 走另一条门，同样用不上。
-- 局部谓词必须用 `CREATE INDEX`（不是 CONCURRENTLY）：scripts/migrate.ts 每个迁移一个事务，
-- CONCURRENTLY 在事务里不可用（0127/0129/0131 同样处理）。`IF NOT EXISTS` 保证可重复执行。
--
-- 2026-11-24 生产实测（同一台机器、同一条 SQL、EXPLAIN ANALYZE）：
--   /api/site/pool 主查询 11.09 s → 1.85 ms（page 驱动 + 本迁移索引 + custom plan + 逐行探针）；
--   计数 1.08 s → 11.4 ms；「今日 N 条/更新于」2.19 s → 59.1 ms；
--   /api/site/timeline 的 grouped anchors 1.92 s → 39.4 ms；`strict + parity` 口径下单测的
--   en 同一段 1.49 s → 0.35 ms（本机 fallback，/en 与 zh 同门，按上面的 zh 数字算）。

-- 中文列表页：公开、可入池、完整正文、中文文案过门。INCLUDE 里放门与筛选真正读的列：
-- selected/visible_after（放行门）、source_id/revision/analysis_id（readiness + 来源全文探针）、
-- channel/category/tags（分类与主题筛选）、published_at/updated_at（「今日 N 条」「更新于」）。
CREATE INDEX IF NOT EXISTS publications_listed_page_idx
  ON publications (timeline_at DESC, article_id)
  INCLUDE (selected, visible_after, source_id, revision, analysis_id, channel, category, tags, published_at, updated_at)
  WHERE visibility = 'public'
    AND eligible
    AND body_mode = 'full'
    AND title ~ '[一-鿿]'
    AND btrim(title) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$'
    AND (summary IS NULL OR btrim(summary) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$');

-- 英文列表页（strict + parity）：在中文列表门之上再要求英文文案当前。这条策略下生产数据里
-- 只有 41 行过门，索引 32 kB；没有它时 /en/all 要把 2.8 万行中文候选全部回表判断英文文案
-- （strict 口径下生产实测 2.5 秒）。
CREATE INDEX IF NOT EXISTS publications_listed_en_page_idx
  ON publications (timeline_at DESC, article_id)
  INCLUDE (selected, visible_after, source_id, revision, analysis_id, channel, category, tags, published_at, updated_at)
  WHERE visibility = 'public'
    AND eligible
    AND body_mode = 'full'
    AND title ~ '[一-鿿]'
    AND btrim(title) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$'
    AND (summary IS NULL OR btrim(summary) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$')
    AND nullif(btrim(title_en), '') IS NOT NULL
    AND nullif(btrim(summary_en), '') IS NOT NULL
    AND english_source_revision = revision;

-- 时间线的分组锚点（timeline.ts 的 queryGroupedAnchors）：要扫完整个精选集算 max(sort_at)，
-- 没法提前停；原来走 `publications_selected_zh_anchor_idx`（(visible_after) INCLUDE 只有
-- sort_at/story_id/fact_id/article_id），每条精选行还要回表取 revision/analysis_id/source_id
-- 做 readiness 与来源探针（生产 46,681 次命中 + 11,892 次读盘）。这条索引把这些列都放进
-- INCLUDE，整个门扫变成 index-only；`visible_after` 仍是索引键，`<= now` 的顺序不变。
-- 10 个 INCLUDE 列不会参与排序，只让索引项变宽：生产 8,812 行 = 1.9 MB。
CREATE INDEX IF NOT EXISTS publications_selected_anchor_idx
  ON publications (visible_after)
  INCLUDE (sort_at, story_id, fact_id, article_id, revision, analysis_id, source_id, channel, category, tags)
  WHERE visibility = 'public'
    AND selected
    AND body_mode = 'full'
    AND title ~ '[一-鿿]'
    AND btrim(title) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$'
    AND (summary IS NULL OR btrim(summary) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$');

-- /en 时间线的同一段（strict + parity）：中文精选 8,812 行里只有 26 行英文文案当前。
-- 没有它时 en 分支仍走上面那条索引，再逐行回表判英文（8,786 行被筛掉、5,582 次读盘、1.49 秒）。
CREATE INDEX IF NOT EXISTS publications_selected_anchor_en_idx
  ON publications (visible_after)
  INCLUDE (sort_at, story_id, fact_id, article_id, revision, analysis_id, source_id, channel, category, tags)
  WHERE visibility = 'public'
    AND selected
    AND body_mode = 'full'
    AND title ~ '[一-鿿]'
    AND btrim(title) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$'
    AND (summary IS NULL OR btrim(summary) !~ '^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$')
    AND nullif(btrim(title_en), '') IS NOT NULL
    AND nullif(btrim(summary_en), '') IS NOT NULL
    AND english_source_revision = revision;