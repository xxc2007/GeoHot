-- 把两扇**我们自己焊死**的门抬到对端文档上限之下（dots 45/分、workbuddy 40/分）。
--
-- 2026-10-12 09:44 在生产上量的结论：近 2 小时每个服务的"最忙一分钟"都**正好等于**它的 per_minute
--   workbuddy 30 = 30、dots 20 = 20、agnes-cn 9 = 9、llm 8 = 8。
-- 同时机器很闲：load 0.94、可用内存 168 MB、`ANALYZE_CONCURRENCY` 已经是 24。
-- ⇒ 限速的不是上游、不是并发、不是机器，是我们写在 budgets 表里的数字。
--
-- 抬的两扇（都留了余量，不是贴顶）：
--   · dots 20 → **45/分**、1,200 → 2,700/时、12,000 → 30,000/天。
--     对端文档是 RPM 60 / TPM 150 万，45 = 文档上限的 75%，留 25%。
--     近 3 小时它 3,165 次尝试里 3,156 次应答（99.7% 成功），是最稳的一扇门。
--     上一轮（#132）抬 dots 没效果，是因为当时卡在**小时窗** 599/600；那次抬了小时窗（0060），
--     现在顶到的是分钟窗，所以这次动分钟窗。
--   · workbuddy 30 → **40/分**、600 → 900/时（+50%，日窗 12,000 见迁移 0061）。
--     站长 2026-10-12 明确要它多担排空。上游 24 小时里没回过 429（失败都是截断，不是限流），
--     但仍只抬 1/3 而不是翻倍——这扇门走的是站长的桌面账号，出事影响的是他本人。
--
-- **没抬的两扇，以及为什么**：agnes-cn 9/分、llm 8/分。这两个数字不是我们保守，是对端的墙——
--   2026-10-10 实测 agnes-cn 每分钟答 5–13 次、超过就 429。抬我们的分钟窗只会让我们更多地撞它的墙，
--   每一次撞墙都进重试阶梯、占一个 worker 槽位，却不多产出一条中文稿。
--   要这两扇变快，得掏钱买档位，那是站长的决定（#154）。
--
-- 熔断是每次调用现读表（`receipts.ts:checkBudget`），所以这次改动**不需要重启 worker**，
-- 也就不会重演 #153（重启把在飞条目钉住最多 30 分钟）。
--
-- 回滚：UPDATE budgets SET per_minute=20, per_hour=1200, per_day=12000 WHERE service='dots';
--       UPDATE budgets SET per_minute=30, per_hour=600 WHERE service='workbuddy';
-- 若抬完之后排空速率没有实测上升（对照 `scripts/archive-progress.ts` 的状态存量差），
-- 就按 #132 的规矩退回来——留着两个没有证据支撑的数字只会让下一次误判"瓶颈不在这儿"。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('dots', 45, 2700, 30000, '模型调用熔断（dots 直连；对端文档 RPM 60 / TPM 150 万，45/分是它的 75%。2026-10-12 实测四扇门的分钟峰值都正好等于自设窗，见本迁移注释）')
  , ('workbuddy', 40, 900, 12000, '模型调用熔断（WorkBuddy 桌面渠道，经 tooling/workbuddy-bridge.ts；hy3 / deepseek-v4.1-flash，免费额度。分钟/小时窗见 0062，日窗见 0061）')
ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour,
  per_day = EXCLUDED.per_day, note = EXCLUDED.note;
