-- 主题关键词：让"非地理/通用"这类粗标签的条目也能落到合适的主题上。
--
-- 依据是 2026-11-05 的覆盖率现场：近 7 天 1,490 条公开条目里 844 条一条主题都没挂上，
-- 其中 95 条标签是「非地理/通用」、21 条「评论/解读」、13 条「机构/动态」，其余没有标签。
-- 这些条目本身是可读的（政经、科技、城市、能源），只是没有具体专题标签。
--
-- 这里只写"读者一眼能判断归属"的词，宁可少写也不要把无关的东西拉进专题页：
-- 每个词都是标题/摘要里出现即成立的名词，不用泛动词（"发展""影响"）当关键词。
UPDATE topics SET keywords = ARRAY['地缘','外交','制裁','关税','贸易战','选举','军事','条约','边界','领土']
 WHERE slug = 'geopolitics';
UPDATE topics SET keywords = ARRAY['产业','制造业','供应链','投资','出口','进口','就业','通胀','GDP','经济增速']
 WHERE slug = 'economic-geography';
UPDATE topics SET keywords = ARRAY['规划','政策','条例','试点','十四五','国土空间','区划调整','批复']
 WHERE slug = 'policy-planning';
UPDATE topics SET keywords = ARRAY['人工智能','大模型','芯片','半导体','算法','数据中心','软件','开源']
 WHERE slug = 'tech-releases';
UPDATE topics SET keywords = ARRAY['研究','论文','团队发现','实验','观测结果','科学']
 WHERE slug = 'research-findings';
UPDATE topics SET keywords = ARRAY['地震','余震','震级','火山喷发','海啸','泥石流','滑坡','山洪']
 WHERE slug = 'disaster-events';
UPDATE topics SET keywords = ARRAY['高温','干旱','暴雨','洪水','寒潮','台风','气旋','升温','极端天气']
 WHERE slug = 'climate-anomaly';
UPDATE topics SET keywords = ARRAY['城市','都市圈','城镇化','通勤','地铁','城中村','旧改']
 WHERE slug = 'urban-geography';
UPDATE topics SET keywords = ARRAY['人口','迁移','流动人口','户籍','老龄化','出生率']
 WHERE slug = 'population-migration';
UPDATE topics SET keywords = ARRAY['高铁','铁路','公路','港口','机场','航运','物流','枢纽']
 WHERE slug = 'transport-geography';
UPDATE topics SET keywords = ARRAY['能源','电力','油气','煤炭','光伏','风电','核电','矿产','锂']
 WHERE slug = 'energy-resources';
UPDATE topics SET keywords = ARRAY['遥感','卫星影像','卫星','SAR','光谱','对地观测']
 WHERE slug = 'remote-sensing';
UPDATE topics SET keywords = ARRAY['地图','制图','图集','投影','比例尺','地名']
 WHERE slug = 'cartography';
UPDATE topics SET keywords = ARRAY['生态','植被','物种','保护区','湿地','森林','草地']
 WHERE slug = 'ecosystems';
UPDATE topics SET keywords = ARRAY['土壤','耕地','土地退化','盐碱化','侵蚀']
 WHERE slug = 'soil-land';
UPDATE topics SET keywords = ARRAY['河流','流域','水库','径流','水位','水资源']
 WHERE slug = 'river-basins';
UPDATE topics SET keywords = ARRAY['海洋','海岸','海平面','珊瑚','近海','洋流']
 WHERE slug = 'ocean-coast';
UPDATE topics SET keywords = ARRAY['冰川','冻土','积雪','冰盖','永久冻土']
 WHERE slug = 'cryosphere';
UPDATE topics SET keywords = ARRAY['导航','北斗','GPS','定位','授时']
 WHERE slug = 'satellite-navigation';
UPDATE topics SET keywords = ARRAY['GIS','空间分析','矢量','栅格','空间数据','地理信息']
 WHERE slug = 'gis-spatial-analysis';
UPDATE topics SET keywords = ARRAY['考察','探险','科考','营地','采样']
 WHERE slug = 'exploration-reports';