-- GDACS 与自然资源部这两个机构主题，初版把「灾害事件 / 预警响应」「政策规划 / 行政区划调整」也写进了 tags，
-- 结果它们各自把整个领域都吞了进来（GDACS 2105 条、自然资源部 972 条），与 `disaster-events`、
-- `policy-planning` 几乎重合 —— 机构主题的读者预期是「这家机构发布了什么」，不是「这个领域有什么」。
-- 2026-11-05 22:0x 复核：收窄到只认机构标签本身，相关主题仍通过 related 指路。
UPDATE topics SET tags = ARRAY['GDACS']::text[] WHERE slug = 'gdacs';
UPDATE topics SET tags = ARRAY['自然资源部']::text[] WHERE slug = 'mnr';