-- 欧空局：主题 `esa` 的 tags 只写了英文 `ESA`，而条目上挂的标签是中文「欧空局」，
-- 于是它一直躺在候选表里（近 30 天 163 条，first_seen 2026-10-07）。
-- 2026-11-05 21:3x 手工跑 `npm run topics:propose` 只剩这一家，原因就是中英别名没对齐。
-- 把中文别名补进同一个主题的 tags：认领与分配都按 tags 走，补上即可两边同时生效。
UPDATE topics
SET tags = tags || ARRAY['欧空局']::text[]
WHERE slug = 'esa' AND NOT ('欧空局' = ANY (tags));