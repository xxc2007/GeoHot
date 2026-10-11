-- 模型健康判定每六十秒问一次账本：「最近十分钟（以及六小时）里，哪些门答不出半数 / 只拿到整天额度拒绝」。
-- 这两条查询筛的是 started_at + origin='live'，而 receipt_attempts 上唯一的非唯一索引是 0033 那条
-- `(service, origin, started_at)`——时间窗没有 service 打头就用不上它，只能全表扫。
-- 生产实测（2026-10-11）：这张表 99,094 行 / 52 MB，且没有任何保留期任务在删它（见 #83），
-- 也就是说这笔每分钟一次的开销会一直变贵。
--
-- 为什么不改成"只查注册表里那几个 service"：健康判定的对象就是**实际用过的门**，按注册表收口会把
-- 只在预算表里出现过的门（以及测试里那条合成 service）漏掉——试过，两条用例立刻红。
-- 所以补一条只覆盖 live 这一支的部分索引：replay/imported 的批量回放不进这条索引，也就不会被回放灌满。
CREATE INDEX receipt_attempts_live_time_idx ON receipt_attempts (started_at) WHERE origin = 'live';
