-- 2026-10-04：站长裁决——「野外考察」(fieldwork) 与「观点与解读」(opinion-analysis) 两个**主题页**一并删掉。
-- 分类层早在 2026-10-03 就删干净了（迁移 0041 + industry/taxonomy.ts 九类改七类），但主题层没跟上：
-- /topics 这张目录里还剩两个和已删分类同名/近名的主题，`/topics/fieldwork` 的 h1 就是「野外考察」、
-- `/topics/opinion-analysis` 的 h1 是「观点与解读」，线上同样是 200。读者看到这两个页面会以为分类根本没删。
-- 站长选择「删掉这两个主题页」而不是改名：全站彻底不再出现这两个名字。
--
-- 为什么需要一条迁移：`seedTopics()`（packages/backend/src/publication/topics.ts:78-93）是
-- `INSERT ... ON CONFLICT (slug) DO UPDATE`，**只 upsert 不删除**。所以只从 industry/topics.json 里拿掉
-- 两行，老部署的 `topics` 表里那两行会原地留下：`/topics` 目录里仍在、`/topics/<slug>` 仍是 200——
-- 正是要消灭的状态。新部署不受影响（迁移先于 seed，此时表还是空的），老部署靠这条 DELETE 收敛。
--
-- 同时清 `related` 的反向引用：JSON 里已删，但表里那 6 行（qinghai-tibet-plateau / osm / landforms /
-- ecosystems / satellite-navigation / exploration-reports）的 `related` 数组里还留着 'fieldwork'。
-- 读取层对取不到的 slug 会静默过滤（topics.ts:212 `topics.find(...)` + `filter`），所以不修也不会显示坏链接，
-- 但留着等于表里存了一个不存在的主题引用，下一次有人按表排查会困惑。seed 会覆盖成 JSON 的值，
-- 这条只是让「只跑迁移不跑 seed」的路径也自洽。
--
-- 不动的层（刻意保留，别顺手删）：
--   · `selectbench_results` 等基准存档里的 `fieldwork` / `opinion-analysis` 是**历史答题记录**，改写等于伪造；
--   · `tooling/corpus/corpus-fieldwork-*.jsonl` 与材料里的 `"theme":"fieldwork"` 是**语料表名**，不是主题 slug；
--   · `industry/taxonomy.ts` 的 `ITEM_TYPES` 里 `exploration_report` / `opinion_analysis`
--     是**内容类型**（渲染成「考察/发现记」「观点与解读」），与主题页同名的只是中文标签；
--   · 历史成刊的日报分节名（`reports.content.sections[].label`）是写死的快照，按设计不回改。

DELETE FROM topics WHERE slug IN ('fieldwork', 'opinion-analysis');

UPDATE topics SET related = array_remove(related, 'fieldwork')
  WHERE 'fieldwork' IN (SELECT unnest(related));

UPDATE topics SET related = array_remove(related, 'opinion-analysis')
  WHERE 'opinion-analysis' IN (SELECT unnest(related));
