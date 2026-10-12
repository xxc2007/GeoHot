-- Google Gemini（AI Studio 的 key）这一行熔断。
--
-- 分钟窗是**对端自己点名的数字**，不是估的：2026-10-12 用本站真实请求形状打这个端点，429 报文写着
--   `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
--    limit: 5, model: gemini-3.8-flash`，并让 22 秒后重试。同一把 key 并发 30 发实测 7 通、21 个 429、
--   2 个 503（12 秒内），与"每分钟 5 次"同向。
--
-- 小时窗取 300 = 5×60：这是分钟窗自己的物理上限，所以它**永远不会先于分钟窗触发**。写它不是为了限速，
--   是为了哪天有人只调分钟窗时，小时窗不至于停在一个比新分钟窗还低的旧值上。
--
-- 天窗取 2,400 = 满速八小时。这一条**不是对端公布的日额度**——免费档的 RPD 官方页只给了表格骨架，
--   我拿不到能核验的数字（第三方文章给的 250/1,500 互相矛盾，也不针对 3.8 flash），所以这里按
--   "一把免费 key 一天最多被敲多久"来定，而不是按"对端允许多少"来定。真正的日天花板在对端：
--   撞上了是 429，而 429 不计入我们的小时/天窗（`receipts.ts:unbilledAttempt`——连不上、被挡回都不产生
--   账单），只进重试阶梯，所以这条窗不会把可用额度提前掐死。哪天站长给这个账号绑了计费，把三格一起抬高即可。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('gemini', 5, 300, 2400, '模型调用熔断（Google AI Studio 免费档；分钟窗是对端 429 报文点名的 limit: 5，小时/日窗见本迁移注释）')
ON CONFLICT (service) DO UPDATE SET per_minute = 5, per_hour = 300, per_day = 2400, note = EXCLUDED.note;
