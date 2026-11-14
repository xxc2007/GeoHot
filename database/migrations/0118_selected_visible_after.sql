-- 补选出来的精选条目没有 `visible_after`，于是永远不放行（2026-11-14 现场）。
--
-- 读者门禁 `listedCondition` 里那句是 `NOT p.selected OR p.visible_after <= now()`：
-- `selected = true` 且 `visible_after IS NULL` 时整个条件求值为 NULL，条目一条都不出现。
-- 生产上 248 条卡在这里（当天 39 条就绪里 27 条），`selected_ready_at` 已写死，
-- `publish.ts` 的「首次满足精选条件才记释放时间」以后再也不会补。
--
-- `refreshSelection` 已经在 `set` 里补上 `visible_after = coalesce(p.visible_after, now())`；
-- 这条迁移把历史存量一次补齐：这些条目本来就是公开、全文、就绪的，补上即是当时能看。
update publications
   set visible_after = now(), updated_at = now()
 where selected = true
   and visible_after is null
   and visibility = 'public';
