-- 2026-10-09：站长要求删掉「考研」(geoedu) 板块。分类词表里已经没有这个 key 了（industry/taxonomy.ts 的
-- CATEGORIES 从七个变六个），库里残留的 'geoedu' 就成了 0041 注释里警告过的那个形状：卡片角标空白、
-- 筛选栏筛不到、日报把它归进兜底分节。所以这一列要一起清。
--
-- 与 0040 / 0041 那两次不同，这一次**没有需要逐条重归类的稿**。2026-10-09 线上实测：
--   · analyses 里 category='geoedu' 只有 **1 行**（2026-10-07 判的），selected=false，relevance=pass；
--   · publications 里对应的 1 行 selected=false、visible_after 为空 ⇒ **从未释放给任何读者**；
--   · 精选、日报版面、RSS、v1、MCP 此刻都查不到一条 geoedu（第 5 节那条 SQL 返回 0 行）。
-- 所以按 0041 的兜底口径置 NULL，不猜一个新分类：NULL 是既有合法状态（线上 analyses 有 9564 行本来就没有
-- 分类），读取层与日报都支持；猜成「人文地理」会凭空给出一个没人判过的角标。
--
-- 信源这一侧：研招网政策与规定（cn-chsi-kydt）是 2026-10-03 专门为这个板块接的（它自己的
-- ingestNoiseFilter.requireTitleMarkers 就是「专业目录/学科/学位/分数线/研究生招生」那一串），板块没了它
-- 就没有服务对象——**停用而不删行**：删行会连带删掉已入库的稿，那是不可逆的，而停用随时可以在后台翻回来。
-- 教育部·新闻发布（cn-web-moe-xwfb）留着：它是 2026-10-05 那轮按「部委新闻」接的，49 条入库稿一条都没被判成
-- geoedu（48 条 NULL + 1 条 human），它只是默认分类写的是 geoedu，所以只清 default_category，不动 enabled。

UPDATE analyses SET category = NULL WHERE category = 'geoedu';
UPDATE publications SET category = NULL WHERE category = 'geoedu';

UPDATE sources
   SET default_category = NULL,
       enabled = false
 WHERE id = 'cn-chsi-kydt';

-- 不点名第二条：库里可以有需要包里没有的行（`docs/manual.md` 第 7 节记着这件事），所以按值清而不按 id 清。
-- 教育部·新闻发布（cn-web-moe-xwfb）的 geoedu 默认分类由这一条覆盖，它的 enabled 不动。
UPDATE sources SET default_category = NULL WHERE default_category = 'geoedu';

-- 信源的 tags 会进写作提示词（editorial/writing.ts:92 把它写成「【来源标签】…」那一行），所以留着「考研」
-- 这个标签就是告诉模型这个板块还在。按值摘掉，不点名 id，也不动其它标签。
UPDATE sources SET tags = array_remove(tags, '考研') WHERE '考研' = ANY(tags);
