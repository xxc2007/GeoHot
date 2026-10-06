-- 0044：把热点榜的 entries 钉成数组。
--
-- 为什么只加一条约束：`events/hot-read.ts` 读榜时对 `entries` 调 `jsonb_array_length`，而这个函数遇到
-- 对象或标量是**抛错**（22023）而不是把这一行过滤掉——写坏一行就能让首页"当前热点"变 500，正是
-- c9e1122 / 3f7974f 花力气硬化过的空榜路径。`0002_events_reports.sql:99` 当初只写了 `jsonb NOT NULL`。
--
-- `NOT VALID` 不回头校验历史行（本机实测 397/397 本来就是数组，不锁表也不因旧数据失败），只挡住未来
-- 的坏形状。
--
-- 同一轮评审还提出：`receipts` / `receipt_attempts` / `fetch_runs` 三张表全仓没有 DELETE 点，本机
-- 5 天就长到 34 MB（约 7 MB/天）。这一支**没有**顺手清空负载，原因记在 `docs/known-issues.md`：
-- `providers/receipts.ts:116,142` 的"同一道题不再付第二次钱"就是靠 `receipts.response` 复放的，
-- 把它置空会把一次缓存命中变成一次解析失败。

ALTER TABLE hot_rankings
  DROP CONSTRAINT IF EXISTS hot_rankings_entries_array,
  ADD CONSTRAINT hot_rankings_entries_array CHECK (jsonb_typeof(entries) = 'array') NOT VALID;
