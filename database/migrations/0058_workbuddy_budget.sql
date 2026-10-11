-- WorkBuddy 渠道（站长桌面版登录的那个账号）的熔断行。
--
-- 这一扇门不是直连上游，而是走 tooling/workbuddy-bridge.ts：桥持有桌面应用的登录凭据，
-- 把 GEOHOT 的非流式请求翻成上游强制的流式请求，再把 SSE 折回一个 JSON 答复。
-- 所以「service」记的是 workbuddy，模型名记在 receipt 里（hy3 / deepseek-v4.1-flash）。
--
-- 数值取自 2026-10-11 在采集机上对上游的实测，不是估的：
--   hy3 用 GEOHOT 自己的 selection-score 提示词跑硬任务：low 22.8s / high 21.4s / max 20.9s，
--       三档隐藏 token 都在 1.9k–2.1k，也就是说思考深度几乎不随档位变 —— 它是「始终思考」型，
--       调档位主要买到的是延迟，不是质量。上下文 192K，单次输出上限 64000。
--   deepseek-v4.1-flash 同样任务 5.6s，上下文 300K，输出上限 128000。
--   两者都走账号的免费额度，上游 usage.credit 记 0，所以这里的限额是**保护上游账号**而不是控成本：
--   真正的风险是并发（ANALYZE_CONCURRENCY 个 worker 共用这一行）和一次思考动辄二十秒。
--   取 30/600/6000：比 deepseek 官方直连（100/2000/20000）保守，因为免费额度是共享的、
--   且额度一旦被上游判定异常，整个网站的分析链都会断。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('workbuddy', 30, 600, 6000, '模型调用熔断（WorkBuddy 桌面渠道，经 tooling/workbuddy-bridge.ts；hy3 / deepseek-v4.1-flash，免费额度）')
ON CONFLICT (service) DO NOTHING;
