-- 2026-10-30 全量扩池：本机 magpie 的全部供应商同步到服务器 magpie（网关 127.0.0.1:3426）后，
-- 新接入的 14 扇门各自的单行预算。与 0097（raccoon/codearts/minimax-code/qoder-global）同一条
-- 规矩：按 service 记账，一个订阅撞墙不连坐别的门。
--
-- 每扇门都在服务器本机对 3426 实测过（1-token 请求 200 + JSON 模式 200，2026-10-30）。
-- 预算值沿用 0097 对同类免费订阅的保守口径（2/30/200）起步——这些门有的是全量 1M 上下文的
-- 大额度订阅，跑出真实吞吐后按 sickServices() 的读数再抬，宁可先紧后松。
--
-- 每扇门自己一个 service（llm.ts 注册表里同名列）：
--   qwenwork / antigravity / trae-cn / trae-global / autoclaw-cn / loomy /
--   minimax-code-global / workbuddy-desktop
-- 同 service 的多把模型（qwenwork×3、antigravity×2、trae-cn×2、loomy×3）共享该行预算，
-- 与 raccoon 三把共享一行的写法一致。
INSERT INTO budgets(service, per_minute, per_hour, per_day, note)
VALUES
  ('qwenwork',           2, 30, 200, '模型调用熔断（服务器 magpie:3426 QwenWork 个人免费版，flash/pro/qwen3.8-max 三把共享；2026-10-30 全量扩池）'),
  ('antigravity',        2, 30, 200, '模型调用熔断（服务器 magpie:3426 Antigravity Google AI Pro，gemini-3.8-flash/claude-opus-4-6-thinking 共享；2026-10-30）'),
  ('trae-cn',            2, 30, 200, '模型调用熔断（服务器 magpie:3426 Trae CN Credits，glm-5.3-flash-max/deepseek-v4.1-flash-max 共享；2026-10-30）'),
  ('trae-global',        2, 30, 200, '模型调用熔断（服务器 magpie:3426 Trae Global Free plan，deepseek-v4.1-flash-max；2026-10-30）'),
  ('autoclaw-cn',        2, 30, 200, '模型调用熔断（服务器 magpie:3426 AutoClaw 国内 Zhipu，zaicoding_glm-5.3/zai_glm-5.3-flash 共享；2026-10-30）'),
  ('loomy',              2, 30, 200, '模型调用熔断（服务器 magpie:3426 Loomy 讯飞，DeepSeek-V4.1-Flash/GLM-5.3-Flash/spark-x2.6 共享；2026-10-30）'),
  ('minimax-code-global',2, 30, 200, '模型调用熔断（服务器 magpie:3426 MiniMax Code Global，M3.1-Flash；2026-10-30）'),
  ('workbuddy-desktop',  2, 30, 200, '模型调用熔断（服务器 magpie:3426 WorkBuddy 中国版桌面订阅，deepseek-v4.1-flash；2026-10-30）')
ON CONFLICT (service) DO NOTHING;
