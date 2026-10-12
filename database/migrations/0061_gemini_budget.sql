-- Google Gemini（AI Studio 的 key）这一行熔断。
--
-- 两个数字都是对端在 429 报文里**自己点名**的（2026-10-12，用本站真实请求形状打这个端量出来的）：
--   `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
--    limit: 5,  model: gemini-3.8-flash`  →  每分钟 5 次；
--   同名指标再撞一次是 `limit: 20 … Please retry in 23h38m41s`  →  **每天 20 次**，且是约 24 小时的滚动窗。
--   同一把 key 并发 30 发实测 7 通、21 个 429、2 个 503（12 秒内），与"每分钟 5 次"同向。
--
-- 所以三格都贴着对端的天花板写，不留余量：
--   · 分钟 5 = 对端的 RPM。
--   · 小时 20、日 20 = 对端的 RPD。小时窗取 20 不是"每小时允许 20 次"，而是**一天总共就 20 次**，
--     小时窗只要不高于日窗即可；把它写成 300 会让"这一小时还能问"这件事变成一句假话。
--   · 日窗为什么必须自己掐到 20：小时/日窗只数**已计费**的尝试（`receipts.ts:unbilledAttempt`，
--     429 不计），所以我们自己不去掐它，它就会在一天里反复撞那堵 23 小时后才挪开的墙——
--     每一次撞墙都进重试阶梯、占一个 worker 槽位，却一条中文稿都不产出。
--
-- 这条门的定位因此是"多一家能判"，不是放量：一天 20 次对 7,900 条待判的档案排空是零头。
-- 它最合适的用法是让**归组复核**那一步换一家模型（`CAPABILITIES.groupReview` 的注释就写着
-- "最好换一家"），或站长手工抽查判断质量。要它承担吞吐，得给这个账号绑计费抬档——那是站长的钱。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('gemini', 5, 20, 20, '模型调用熔断（Google AI Studio 免费档：对端 429 报文点名 5 次/分钟、20 次/天，见本迁移注释）')
ON CONFLICT (service) DO UPDATE SET per_minute = 5, per_hour = 20, per_day = 20, note = EXCLUDED.note;
