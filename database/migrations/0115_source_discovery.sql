-- 发现来的候选信源要能和人工登记的行分开：语言、地区、怎么发现的、审核时看到的读数。
-- 只加列和索引，不改任何现有行——现有启用信源与备用池的语义不变，
-- discovered_via 为 NULL 就是「不是 discovery 流程发现的」，审核脚本据此筛选。
ALTER TABLE sources ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS discovered_via text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS review_note text;

-- 审核列表按「发现来源是否有值」先筛一遍；普通（非并发）建索引，迁移脚本本身在事务里跑。
CREATE INDEX IF NOT EXISTS sources_discovered_via_idx ON sources (discovered_via);
