-- WorkBuddy 中国版渠道（copilot.tencent.com）的熔断行。
--
-- 为什么要单独一行，而不是复用 workbuddy 那一行：那是**另一个账号**。
-- 国际版 www.workbuddy.ai 与中国版 copilot.tencent.com 是两个独立产品、两次登录、两份额度，
-- 桥也是两条（3065 / 3066），凭据两份。receipts 与 budgets 都按 service 记账，共用一行
-- 会让一个账号被限流时花掉另一个账号的速率窗，而这两份额度本来就是为了互为备份才接的。
--
-- 2026-10-12 实测的两侧对照（同一条 GEOHOT selection-score 提示词、同 model id、`reasoning_effort: max`）：
--   国际版 deepseek-v4.1-flash：HTTP 429 `{"code":6004,"msg":"usage exceeds frequency limit … reset at
--     2026-10-12 19:10:18 UTC+8"}`，90 分钟内 236 次尝试 0 成功，而同账号的 hy3/glm/step-5-preview
--     照常答话 —— 墙在账号上，不在模型上。
--   中国版同一个 deepseek-v4.1-flash：3749 ms、`finish_reason: stop`、隐藏链 212 token、credit 0.03。
--
-- 数值沿用 workbuddy 那一行的 30/600/12000（0061 抬过日窗、0063 退回过速率），理由同样不是控成本：
-- 中国版这一步的 credit 也是 0.00–0.11 一档，限额是**保护上游账号**不被判异常。两个账号各自独立，
-- 所以两行各自完整额度，不拆分、不共享。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('workbuddy-cn', 30, 600, 12000, '模型调用熔断（WorkBuddy 中国版渠道，经 3066 端口上的桥；deepseek-v4.1-flash / hy3 / glm-5.3-flash / step-5-preview，与中国版账号同额度）')
ON CONFLICT (service) DO NOTHING;
