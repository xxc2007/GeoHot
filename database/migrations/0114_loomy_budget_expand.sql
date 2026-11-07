-- 讯飞 Loomy（loomy-deepseek-v41-flash / glm53-flash / spark-x2.6 共享一行预算）从
-- 2/30/200 扩到 40/1200/20000。
-- 现场：PREFILTER_MODEL / SCORE_MODEL 的第一位都写的是 loomy-deepseek-v41-flash，
-- 但 10 分钟窗口的 receipts 里 loomy 恒为 0，全部落在 dots / workbuddy-cn 上；
-- 原因是 per_minute=2 一上来就被打满，预算兜底（budgetFallbackModelsForPurpose）
-- 随即把候选换成别家——池首于是「配了也不走」，而日志里连一次失败都看不到。
-- 扩额后池首才有机会占住它该占的份额。
UPDATE budgets
SET per_minute = 40,
    per_hour = 1200,
    per_day = 20000,
    note = '模型调用熔断（服务器 magpie:3426 Loomy 讯飞，三把模型共享；2026-11-08 扩额，原先 2/30/200 让池首形同虚设）',
    updated_at = now()
WHERE service = 'loomy';
