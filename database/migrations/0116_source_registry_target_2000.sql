-- 业主 2026-11-08 的要求：启用信源从 666 扩到 2000（国内外都要，覆盖面要全）。
-- 这一步只抬高政策上限，不启用任何一行：真正启用走 scripts/review-sources.ts 的 --enable，
-- 按批放行并盯读者面（这台 891 MB 的机器上，信源一台一台加才会暴露取数成本）。
--
-- 现场（2026-11-08 05:08）：target_enabled=666 / target_total=666 / 实际 enabled=666 / 总行 1191；
-- 也就是说「插候选」这一步本身就会被 target_total 挡住，工具链写完了也跑不动。
-- 只在「原值是 666」时才抬：干净的测试库/新装实例里 target_enabled 是 NULL，
-- 那是「非托管」状态，createSource 靠它决定新信源默认是否启用，不能被这条迁移改掉。
UPDATE source_registry_policy
SET target_enabled = 2000,
    target_total = 2400,
    updated_by = 'operator:source-expansion-2000',
    reason = '业主 2026-11-08：启用信源扩到 2000，先抬上限；启用按批放行并观察读者面',
    updated_at = now()
WHERE singleton
  AND target_enabled = 666;
