-- 2026-11-06 站长点名的 6 个机构热词正式升成主题。
--
-- 现场（production，2026-11-06 03:5x）：
--   topics 里已有 nasa(NASA)、copernicus(哥白尼计划)、fao(联合国粮农组织)、gdacs(GDACS)、mnr(自然资源部)，
--   但主题只认自己 tags 里写死的那个名字：
--     · 「哥白尼」214 条、「粮农组织」119 条 挂在 publications.tags 上，却不等于「哥白尼计划」「联合国粮农组织」；
--     · 「欧空局」168 条 没有对应主题（ESA 缺席 43 个主题之外）。
--   结果就是 topic_proposals 一直把它们当成「没人认领的新候选」，而 tagged 的文章进不了分类页。
--
-- 这次只补身份、不改口径：机构主题只认机构名（2026-11-05 0108 的教训：把体裁词写进机构 tags
-- 会让 gdacs 吞掉 2,105 条灾害条目）。NASA / GDACS / 自然资源部 已经对齐，这里只补缺的三处。

-- 哥白尼计划 ← 哥白尼（同一个人两套写法，读者搜索与标签都在用后者）
UPDATE topics
   SET tags = (SELECT array_agg(DISTINCT x) FROM unnest(tags || ARRAY['哥白尼']) AS x)
 WHERE slug = 'copernicus'
   AND NOT (tags @> ARRAY['哥白尼']);

-- 联合国粮农组织 ← 粮农组织
UPDATE topics
   SET tags = (SELECT array_agg(DISTINCT x) FROM unnest(tags || ARRAY['粮农组织']) AS x)
 WHERE slug = 'fao'
   AND NOT (tags @> ARRAY['粮农组织']);

-- 欧空局：43 个主题里一直没有它，168 条带「欧空局」标签的文章无处可去。
INSERT INTO topics (slug, name, grp, tags, definition, related, position)
VALUES (
  'esa',
  '欧空局（ESA）',
  'company',
  ARRAY['欧空局', '欧洲空间局'],
  '欧洲空间局（ESA）的观测计划、卫星任务与公开数据；与 NASA、哥白尼计划常常同时出现在一条消息里。',
  ARRAY['nasa', 'copernicus', 'remote-sensing'],
  45
)
ON CONFLICT (slug) DO NOTHING;

-- 顺带把 NASA 的大小写变体认领掉（proposals 里出现过小写 nasa）。
UPDATE topics
   SET tags = (SELECT array_agg(DISTINCT x) FROM unnest(tags || ARRAY['Nasa']) AS x)
 WHERE slug = 'nasa'
   AND NOT (tags @> ARRAY['Nasa']);