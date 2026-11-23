-- 四个早期迁移建的主题只有中文名/中文说明（0106 的 GDACS、自然资源部，以及本机后加的两个区域主题）。
-- 0128 给了 topics.name_en / definition_en 两列，但 `seedTopics()` 只覆盖 industry/topics.json 里的 43 个；
-- 这四行不在 JSON 里，/en/topics 于是把中文名与中文说明原样印在英文页上（2026-11-23 验收：4 个主题、
-- 12 个中文文本节点）。
--
-- 红线：只填 NULL，不覆盖已经写好的英文；不动 name/definition/tags/position。
UPDATE topics SET
  name_en = 'Arid West Asia and North Africa',
  definition_en = 'The arid belt from the Sahara to the Iranian plateau: how water scarcity, oil and gas geography and border disputes reinforce one another and spill over into migration and corridor risk.'
 WHERE slug = 'arid-west-asia-north-africa' AND (name_en IS NULL OR btrim(name_en) = '');

UPDATE topics SET
  name_en = 'East China coastal city region',
  definition_en = 'China''s densely urbanised eastern seaboard: the front line of typhoons and storm surges, the country''s highest concentration of economy and transport, and a region where subsidence and sea-level rise compound.'
 WHERE slug = 'east-china-coastal-city-region' AND (name_en IS NULL OR btrim(name_en) = '');

UPDATE topics SET
  name_en = 'GDACS global disaster alerts',
  definition_en = 'The Global Disaster Alert and Coordination System run by the European Commission and the United Nations: automatic alerts and impact estimates for earthquakes, tropical cyclones, floods and wildfires, and a first-hand roundup of cross-agency disaster events.'
 WHERE slug = 'gdacs' AND (name_en IS NULL OR btrim(name_en) = '');

UPDATE topics SET
  name_en = 'China Ministry of Natural Resources',
  definition_en = 'The Ministry of Natural Resources and its subordinate bodies: territorial spatial planning, farmland protection, geological survey and marine forecasting — the official outlet for territorial-space use control and resource survey bulletins.'
 WHERE slug = 'mnr' AND (name_en IS NULL OR btrim(name_en) = '');

-- 验收样本的信源名也是中文（`验收样本 · 中文源`），/en 的卡片与事件时间线会原样带出。
-- 它不是专名，补一个英文写法；只填空值，不影响真实信源。
UPDATE sources SET name_en = 'Verification sample · Chinese source'
 WHERE id = 'enverify-zh-source' AND (name_en IS NULL OR btrim(name_en) = '');