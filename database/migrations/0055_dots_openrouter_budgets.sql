-- 两扇新门的熔断行（站长 2026-10-10 给的两把 key）。
--
-- 数值来自当天在采集机上对端点本身的实测，不是估的：
--   dots（小红书 dots3-note-prev）：开思考时一次 13–19 秒、1.1k–1.6k 隐藏 token，4 连发 4 个 200、0 次 429；
--       文档写的默认上限是 RPM 60 / TPM 150 万，512K 上下文。熔断取 20/600/6000：比文档保守三分之二，
--       因为站点真正吃紧的是并发（ANALYZE_CONCURRENCY 个 worker 共用这一行）。
--   openrouter：这把 key 是指到 *管理/开通* 用的（`GET /api/v1/key` 回 `is_management_key: true`），
--       `/models` 能列 458 个模型、任何 chat/completions 都回 401 `User not found`。推理得另建一把普通 key，
--       所以它**暂时不进 MODEL_POOL**；行先建好，key 一到位就只差改一行环境变量。
--       免费档的公开额度约 20 次/分钟、50 次/天，先按 15/300/6000 记（日额度比公开值宽，
--       真正卡住的是对端，不是我们的熔断）。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('dots', 20, 600, 6000, '模型调用熔断（小红书 dots3-note-prev，512K 上下文，开思考）'),
  ('openrouter', 15, 300, 6000, '模型调用熔断（OpenRouter 免费档；当前这把 key 是管理 key，推理要用普通 key）')
ON CONFLICT (service) DO NOTHING;
