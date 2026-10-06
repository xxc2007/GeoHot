-- 0045：`selected_state` 与 `articles` 之间补上外键，并把已经悬空的状态行清掉。
--
-- 为什么必须补：Agent 用的同步快照（`/api/v1/selected/snapshot`）以前把"这条还在精选集合里"这件事
-- 全权交给 `selected_state.in_set`。写入侧本身是对的——`publication/publish.ts:314` 的
-- `selected && visibility='public' && hasChineseCopy(title)` 与站内每一条列表用的是同一份门槛，
-- 撤下、改成仅摘要、丢掉中文标题都会写一条 `remove` 并把 `in_set` 关掉。**没有任何一处负责"这一行文章被硬删"**：
-- 这张表原先一个外键都没有，`DELETE FROM articles` 既不级联也不报错。2026-10-05 本机 CI 库实测形状是
-- `selected_state` 1311 行、其中 1055 行 `in_set=true` 而对应的 `articles` 行早已不存在，
-- 快照于是把 1055 个没有详情页（404）的条目当作在线精选吐给客户端。同一形状每次跑测试都会再涨一截：
-- `tests/setup.ts:83` 的 `purgeTagged` 删 `articles` 并依赖级联清掉 `publications` / `analyses`，
-- 而级联到不了一张没有外键的表。
--
-- 两条动作各管一件事，别把它们混成一条：
-- 1) 读取侧不再信这份拷贝：`publication/v1.ts` 的 `selectedSnapshot` 改成
--    `JOIN publications p ON p.article_id = latest.article_id AND selectedCondition(now)`，
--    首页 / v1 selected / RSS 用的就是这条门槛。这一条不依赖本迁移，装上立刻生效，
--    也是"库里还有历史脏行时接口先不再说谎"的那一半。
-- 2) 本迁移：外键 + 清掉既存悬空行。有了级联，写侧下一次差异判断读到的是"确实不在了"，
--    而不是一条指向已删文章的状态行。
--
-- 刻意不动的层：`selected_ledger`。它是给客户端重放的变更日志，不是成员判定；把它的历史行跟着文章级联删掉，
-- 会让游标停在删除点之前的客户端**永远学不到这一条消失**（`selectedChanges` 只回 `seq` 大于游标的行）。
-- 快照才是重新对齐的机制，而第 1 条已经保证快照不再吐出没页面的条目。
--
-- 先删悬空行再建外键，否则 `ADD CONSTRAINT` 会被既存数据挡住；`NOT VALID` 在这里不适用——
-- 悬空行是真的要清走，不是留着待查。

DELETE FROM selected_state st
 WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = st.article_id);

ALTER TABLE selected_state
  DROP CONSTRAINT IF EXISTS selected_state_article_id_fkey,
  ADD CONSTRAINT selected_state_article_id_fkey FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE;
