-- WorkBuddy 桌面渠道的日窗 6,000 → 12,000（小时窗与分钟窗都不动）。
--
-- 站长 2026-10-12 明确要 WorkBuddy 那两扇门（hy3 / deepseek-v4.1-flash）多担一点排空，
-- 这是那次授权下改的值——不是单方面抬别人的账号。数值先在生产上直接 UPDATE 过，这条迁移
-- 把它回写成代码（同 dots 的 0059/0060 那条规矩：**生产改过的运维值必须回写成迁移**，
-- 否则下一次 `npm run db:migrate` 或恢复演练会静默打回 6,000）。
--
-- 为什么只动日窗。2026-10-12 09:14 读生产 `receipt_attempts`：
--   · workbuddy 连续 11 个小时**每小时正好答满 600 次**（= 我们自己的 per_hour），
--     24 小时里 0 失败（只有一个小时挂了 17 次）；
--   · 600 × 10 小时 = 6,000 = per_day ⇒ 它每天跑满十小时就熄火，剩下的十几个小时完全不用。
-- 也就是说：上游已经证明它能吃下 600 次/小时这个速率，缺的不是速率是**小时数**。
-- 所以把日窗翻倍到 12,000（= 600/时 × 20 小时，留 4 小时夜间余量），分钟/小时窗一个字不改——
-- 上游看到的瞬时压力与今天完全一样，只是每天多干 10 个小时。
--
-- 效果按排空算：workbuddy 现在一天 6,000 次调用，约占全站 24,700 次的四分之一；
-- 抬到 12,000 ⇒ 每天多 6,000 次 ÷ 每条档案约 5.3 次调用 ≈ **多判约 1,100 条/天**。
--
-- 回滚就一行：UPDATE budgets SET per_day = 6000 WHERE service = 'workbuddy' AND per_day = 12000;
-- 若上游哪天开始回 429/402，先按 `sickServices()` 的读数判断，再决定要不要退回来——
-- 这把闸保护的是站长的桌面账号，不是钱（`service_prices` 是空表，`cost = 0` 不等于免费）。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('workbuddy', 30, 600, 12000, '模型调用熔断（WorkBuddy 桌面渠道，经 tooling/workbuddy-bridge.ts；hy3 / deepseek-v4.1-flash，免费额度。日窗 6000→12000 见本迁移注释：2026-10-12 实测它连续 11 小时每小时正好答满 600 次、0 失败，然后撞日窗熄火）')
ON CONFLICT (service) DO UPDATE SET per_day = 12000, note = EXCLUDED.note
  WHERE budgets.per_day = 6000;
