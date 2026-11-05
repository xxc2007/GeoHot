-- 2026-11-06：机构主题要认「机构名的各种写法」。
--
-- 0109 给 copernicus/fao 补了「哥白尼」「粮农组织」两个标签，但机构主题的匹配口径是
-- `entity:<id>`（只认这家机构作为来源主体的文章），标签根本没参与 —— 于是
-- `publications.tags` 里 214 条「哥白尼」、119 条「粮农组织」、168 条「欧空局」仍然进不来。
--
-- 又不能简单地把机构主题的全部 tags 并进来：0106 那次 gdacs 吞掉 2,105 条灾害条目就是
-- 这么来的（tags 里混着体裁词）。所以单独一列 `org_names`：只放机构名本身的各种写法，
-- 匹配时 `entity:<id>` 与 `org_names` 取并集，`tags` 仍只服务字段/体裁主题。

ALTER TABLE topics ADD COLUMN IF NOT EXISTS org_names text[] NOT NULL DEFAULT '{}';

UPDATE topics SET org_names = ARRAY['中国地震台网', '中国地震台网中心', 'CENC'] WHERE slug = 'cenc';
UPDATE topics SET org_names = ARRAY['中国气象局', 'CMA'] WHERE slug = 'cma';
UPDATE topics SET org_names = ARRAY['USGS', '美国地质调查局'] WHERE slug = 'usgs';
UPDATE topics SET org_names = ARRAY['NOAA', '美国国家海洋和大气管理局'] WHERE slug = 'noaa';
UPDATE topics SET org_names = ARRAY['NASA', 'Nasa', '美国航空航天局'] WHERE slug = 'nasa';
UPDATE topics SET org_names = ARRAY['哥白尼', '哥白尼计划', 'Copernicus'] WHERE slug = 'copernicus';
UPDATE topics SET org_names = ARRAY['世界气象组织', 'WMO'] WHERE slug = 'wmo';
UPDATE topics SET org_names = ARRAY['IPCC'] WHERE slug = 'ipcc';
UPDATE topics SET org_names = ARRAY['OpenStreetMap', 'OSM'] WHERE slug = 'osm';
UPDATE topics SET org_names = ARRAY['粮农组织', '联合国粮农组织', 'FAO'] WHERE slug = 'fao';
UPDATE topics SET org_names = ARRAY['GDACS'] WHERE slug = 'gdacs';
UPDATE topics SET org_names = ARRAY['自然资源部', '中国自然资源部', 'MNR'] WHERE slug = 'mnr';
UPDATE topics SET org_names = ARRAY['欧空局', '欧洲空间局', 'ESA'] WHERE slug = 'esa';