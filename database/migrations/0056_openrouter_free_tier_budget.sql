-- OpenRouter 这一行熔断要养六个成员（`or-nemotron-ultra/nano/super`、`or-dots-studio`、`or-lfm`、
-- `or-north-mini-code`），它们都在免费档，而**免费档的额度是按账号算的**：文档写约 20 次/分钟，
-- 日额度和账号信用有关（<10 信用时 50 次/天，≥10 时 1000 次/天）。0055 给的 15/300/6000 是"一条通路"的
-- 尺寸，成员一多就失真了。
--
-- 现值取 18/300/600：分钟贴着文档的 20 留一点余量，日额度落在两个档之间——**刻意取小**，因为真正的
-- 天花板在对端，不在我们这儿。撞上对端限制时 429 会被 `sickServices()`（十分钟里答不出半数就换人）
-- 送到池子边上，熔断再收紧只会让这条通路少用而不是乱用；哪天量到账号有更高的日额度，把这一行调大即可。
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('openrouter', 18, 300, 600, '模型调用熔断（OpenRouter 免费档，六个成员共用同一账号额度）')
ON CONFLICT (service) DO UPDATE SET per_minute = 18, per_hour = 300, per_day = 600, note = EXCLUDED.note;
