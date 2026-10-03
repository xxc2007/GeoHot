-- 2026-10-03：站长要求把筛选栏里并排的两个区域（地理信息技术 / 地理信息系统）合并成一个，名叫「地理信息系统」。
-- key 保留 `geotech`——它已经在网址（/all?category=geotech）与库里，taxonomy.ts 的头部注释写着上线后不可改；
-- 另一个 key `gis` 只活了几个小时（2026-10-03 傍晚随板块上线），把它名下的行迁到 `geotech` 后从词表里删掉。
-- 四处都要跟着迁，少一处就会出现「分类不在词表里」的行：列表角标空白、筛选筛不到、日报按兜底分节归档。
UPDATE publications SET category = 'geotech' WHERE category = 'gis';
UPDATE analyses SET category = 'geotech' WHERE category = 'gis';
UPDATE editorial_overrides SET fields = jsonb_set(fields, '{category}', '"geotech"') WHERE fields ->> 'category' = 'gis';
UPDATE sources SET default_category = 'geotech' WHERE default_category = 'gis';
