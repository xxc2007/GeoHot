-- magpie 的 auto 路由（服务器 127.0.0.1:3426 的 /v1，模型名 auto/*）需要自己的熔断行。
--
-- 为什么单独一行而不是并进 `loomy`：`budgets.service` 是熔断粒度，receipts.ts 按
-- `budget:<service>` 加咨询锁再查这一行。auto/* 是网关自己的路由（背后可能是任意成员，
-- 会随 magpie 的 decisions 变），与 loomy 那把账号的余量不是一回事；并成一行就分不清
-- 是网关在限流还是账号欠费。
--
-- 数值取保守值：auto 路由的延迟未知（实测 hy3 1-token 200，dfmodel 45 秒超时），
-- 先给它一个不会把并发堆到上游的窗口，等真实回填跑起来再按实测调。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('auto', 20, 900, 12000, '模型调用熔断（服务器 magpie 的 auto 路由，与 loomy 账号分开计）')
ON CONFLICT (service) DO NOTHING;
