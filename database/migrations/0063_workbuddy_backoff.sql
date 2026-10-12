-- workbuddy 这扇门抬上去 15 分钟就被对端点名，退回实测无拒绝的那一档（分钟 40→30、小时 900→600）。
--
-- 迁移 0062 抬它之前的依据是"上游 24 小时里没回过 429"——那句话在它写下的那一刻是真的，
-- 而它失效只用了一刻钟。生产台账（`receipt_attempts`）实测：
--   · 04:00–09:40 连续 5 个多小时，每 10 分钟桶的失败数全是 **0**；
--     而 04/05/06/07 每个整点小时都正好是 255+255+90 = **600 次** ⇒ 那时顶住它的是我们自己的小时窗。
--   · 抬到 40/900 之后：09 点这一小时 910 次尝试、873 次应答、37 次失败；
--     第一次拒绝出现在 **09:52:34**，到 10:02 共 49 次，形状是同一条：
--     `workbuddy rate limited (HTTP 4xx): {"code":N,"msg":"usage exceeds frequency limit,
--      but don't worry, your usage will resume…"}` ——对端的频率墙，不是截断、不是我们的熔断
--     （我们的熔断在派发前就拦下，不产生 attempt 行）。
--   · 拒绝的 49 次不计费（429 走 `unbilledAttempt`），所以不会撑爆我们的窗，但每一次都进重试阶梯、
--     占一个 worker 槽位，而这扇门背后是站长的桌面账号。
--
-- 净收益确实是有的（873 应答/时 vs 600 应答/时），但站长这次的要求写得很清楚是
-- **"用最快的速率（不要达到限制）"**——现在已经撞到限制上了，所以退回到有 5 小时证据的无拒绝区间：
-- 分钟 30、小时 600。**日窗 12,000 保留**（那是迁移 0061 站长自己拍的排空额度，不是这次误判的一部分）。
--
-- 想再往上抬只有一条正路：让对端那个频率墙本身变高（付费档），或者把排空往 dots 那扇门倾斜
-- ——dots 抬到 45/2700 之后同样这段时间 **0 次拒绝**，384 次尝试 374 次应答，它是真的还有余量。
--
-- 熔断每次调用现读表（`receipts.ts:checkBudget`），改它不需要重启 worker（#153）。
--
-- 回滚（如果哪天对端放宽了，或站长决定吃这点拒绝换吞吐）：
--   UPDATE budgets SET per_minute = 40, per_hour = 900 WHERE service = 'workbuddy';
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('workbuddy', 30, 600, 12000, '模型调用熔断（WorkBuddy 桌面渠道，经 tooling/workbuddy-bridge.ts；hy3 / deepseek-v4.1-flash，免费额度。对端频率墙实测：抬到 40/900 后 09:52 起 10 分钟内拒绝 49 次，0062 的那次抬高已退回，见本迁移注释；日窗 12,000 见 0061）')
ON CONFLICT (service) DO UPDATE SET per_minute = 30, per_hour = 600, per_day = 12000, note = EXCLUDED.note;
