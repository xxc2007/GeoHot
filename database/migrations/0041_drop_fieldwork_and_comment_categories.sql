-- 2026-10-03：站长要求删掉「野外与考察」(fieldwork) 与「观点与解读」(comment) 两个分类，
-- 并把「地理信息系统」提到「考研」之前（换位只动 industry/taxonomy.ts 与 industry/boards.json 的顺序，
-- 不涉及数据）。删分类要迁数据：词表里没有的 key 留在库里，会出现角标空白、筛选筛不到、日报按兜底分节
-- 归档的行——正是 0040 注释里警告的那个形状，所以这两列必须一起清。
--
-- 为什么不能像 0040 那样一条 blanket UPDATE：这两个分类是兜底桶，同一桶里的条目分属不同学科。
-- 2026-10-03 线上实测 publications 里 category ∈ (fieldwork, comment) 共 21 行（comment 13 / fieldwork 8），
-- 其中 8 行是精选（comment 6 / fieldwork 2，也就是读者能看见的那 8 条）。逐条读标题与标签后按内容重归类：
--   · 评论/解读 类：讲气候、海平面、洪水与厄尔尼诺本体 → physical；讲政策、规划、社会不公、能源 → human。
--   · 考察/记录 类：野外测量与生态观测 → physical；乡村社会调查与人口迁移 → human；
--     1855 年地质雕塑步道与 1165 年古战场踏查是史料 → histgeo。
-- 逐条映射之后仍有一条兜底：本机库里 analyses 还有同一 article_id 的多个 revision（如 science-L14），
-- 线上没有但在别的部署里可能有。兜底把剩下的置 NULL 而不是猜一个分类——NULL 是既有合法状态
-- （线上精选里本来就有 2 条没有分类字段），读取层与日报都支持；猜错会给出一个错的角标。
--
-- 不迁 selectbench_results：那是评测跑分的存档，category 记录的是**当时模型给出的答案**，
-- 改写它等于篡改基准记录。它只在后台按 run 浏览，不参与任何公开出口。
CREATE TEMP TABLE geohot_category_remap (article_id text PRIMARY KEY, category text NOT NULL) ON COMMIT DROP;

INSERT INTO geohot_category_remap (article_id, category) VALUES
  -- comment（观点与解读）→ physical
  ('fieldwork-L5', 'physical'),   -- 解读：海平面上升为什么已是"生存威胁"
  ('fieldwork-L7', 'physical'),   -- 分析：尼泊尔的 2,000 万美元损失与损害申请
  ('fieldwork-L9', 'physical'),   -- 访谈：强到"没有学名"的厄尔尼诺
  ('fieldwork-L10', 'physical'),  -- 解读：马里布的"沙债"到期
  ('fieldwork-L13', 'physical'),  -- 社论：超级厄尔尼诺
  ('science-L13', 'physical'),    -- 季风尾段的狠击：尼泊尔暴雨引发 285 处滑坡
  ('fill-grist-elnino-naming', 'physical'),
  ('fill-guardian-nepal-tibet-editorial', 'physical'),
  -- comment（观点与解读）→ human
  ('fieldwork-L6', 'human'),      -- 分析：卢拉任内避免了 2 万平方公里亚马逊毁林
  ('fieldwork-L8', 'human'),      -- 解读：热成像揭开极端高温的隐形不公正
  ('fieldwork-L11', 'human'),     -- 调查：锂矿议程开进美国"被遗忘的野生动物走廊"
  ('fieldwork-L12', 'human'),     -- 评论：打击环境犯罪，要沿整条供应链追利润
  ('fieldwork-L14', 'human'),     -- 公开信：Our message to global leaders
  -- fieldwork（野外与考察）→ physical
  ('china-L20', 'physical'),      -- 四个黄土区野外站六十余年实测
  ('fieldwork-L3', 'physical'),   -- 奥塔哥半岛现场记录：黄眼企鹅只剩 117 对繁殖亲鸟
  ('fill-physorg-guliya-ice-core', 'physical'),
  -- fieldwork（野外与考察）→ human
  ('china-L21', 'human'),         -- 陇中黄土丘陵区乡村社会网络结构特征
  ('fieldwork-L2', 'human'),      -- 一线记录：戈罗姆安置营
  ('fill-guardian-eriskay-ponies', 'human'),
  -- fieldwork（野外与考察）→ histgeo
  ('fieldwork-L1', 'histgeo'),    -- 现场踏查：水晶宫公园里 1855 年的"深时步道"
  ('fieldwork-L4', 'histgeo');    -- Country diary：1165 年克罗根战役

UPDATE publications p SET category = m.category
  FROM geohot_category_remap m
  WHERE p.article_id = m.article_id AND p.category IN ('fieldwork', 'comment');

UPDATE analyses a SET category = m.category
  FROM geohot_category_remap m
  WHERE a.article_id = m.article_id AND a.category IN ('fieldwork', 'comment');

UPDATE editorial_overrides o SET fields = jsonb_set(o.fields, '{category}', to_jsonb(m.category))
  FROM geohot_category_remap m
  WHERE o.article_id = m.article_id AND o.fields ->> 'category' IN ('fieldwork', 'comment');

-- 兜底一：映射表之外的来源声明。线上 sources.default_category 里没有这两个 key，但别的部署可能有。
UPDATE sources SET default_category = NULL WHERE default_category IN ('fieldwork', 'comment');

-- 兜底二：映射表之外的条目（本机特有的未发布 revision 等）落回"没有分类"，不留词表外的 key。
UPDATE publications SET category = NULL WHERE category IN ('fieldwork', 'comment');
UPDATE analyses SET category = NULL WHERE category IN ('fieldwork', 'comment');
-- 人工覆盖里剩的这两个 key：删掉这一栏，让模型判断与来源声明重新接手（留着会写出词表外的分类）。
UPDATE editorial_overrides SET fields = fields - 'category'
  WHERE fields ->> 'category' IN ('fieldwork', 'comment');
