-- 备用池上限数据库强制 + 正式/备用互斥 + canonical URL 查重 + 回填。
-- 2026-11-16 根因修正 v3：
--   1. 上限约束非隔离/非归档的全部备用候选行（不只 eligible=true）
--   2. canonical_url 基于 config->>url/feedUrl 规范化回填
--   3. 迁移前检测重复而非直接建唯一索引失败
--   4. reserve guard 同时检查 canonical 与 active 池互斥
--   5. UPDATE validated_at/eligible/quarantined 都保持互斥

-- ============================================================
-- STEP 1: 加列（幂等）
-- ============================================================
ALTER TABLE source_registry_policy ADD COLUMN IF NOT EXISTS target_reserves integer NOT NULL DEFAULT 1000;
ALTER TABLE source_registry_policy ADD COLUMN IF NOT EXISTS reserve_candidates_count integer NOT NULL DEFAULT 0;
ALTER TABLE source_registry_policy ADD COLUMN IF NOT EXISTS reserve_fresh_count integer NOT NULL DEFAULT 0;

ALTER TABLE source_reserves ADD COLUMN IF NOT EXISTS quarantined boolean NOT NULL DEFAULT false;
ALTER TABLE source_reserves ADD COLUMN IF NOT EXISTS quarantine_reason text;

ALTER TABLE sources ADD COLUMN IF NOT EXISTS canonical_url text;

-- ============================================================
-- STEP 2: 回填 canonical_url
--   - GET/RSS/web_list: normalize(config->>'url')
--   - POST search:
--     normalize(endpoint) + "#" + discriminator
--     discriminator 按优先级从 config 提取：
--       1. config->>'searchTopic'
--       2. config->>'query'
--       3. config->>'topic'
--       4. config->'bodyJson'->>'query'           (Tavily/Exa/Keenable)
--       5. config->'bodyJson'->'messages'->0->>'content'  (百度千帆)
--     同 endpoint 不同 query 允许共存；同 query 不同 id 互斥。
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_canonical_url(raw text, cfg jsonb DEFAULT NULL) RETURNS text AS $$
DECLARE
  u text;
  disc text;
BEGIN
  IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
  u := raw;
  -- 去 fragment
  u := split_part(u, '#', 1);
  -- 去 utm_* 查询参数
  u := regexp_replace(u, '([?&])utm_[^&]*', '\1', 'g');
  u := regexp_replace(u, '&&', '?');
  -- 去 trailing slash
  u := regexp_replace(u, '/+$', '');
  -- 小写 scheme+host
  u := regexp_replace(u, '^([a-zA-Z]+://[^/]+)', lower('\1'));
  -- POST search discriminator: 嵌套 bodyJson 优先
  IF cfg IS NOT NULL THEN
    disc := COALESCE(
      cfg->>'searchTopic',
      cfg->>'query',
      cfg->>'topic',
      cfg->'bodyJson'->>'query',
      cfg->'bodyJson'->'messages'->0->>'content',
      ''
    );
    IF disc != '' THEN
      u := u || '#' || lower(regexp_replace(disc, '\s+', '-', 'g'));
    END IF;
  END IF;
  RETURN u;
END $$ LANGUAGE plpgsql;

-- 回填 sources.canonical_url（带 discriminator）
UPDATE sources
SET canonical_url = normalize_canonical_url(
  COALESCE(config->>'url', config->>'feedUrl', ''),
  config
)
WHERE canonical_url IS NULL;

-- ============================================================
-- STEP 3: 重复检测（dry-run 报告，不直接建唯一索引）
--   输出：active 池内 canonical 重复的 id 对
-- ============================================================
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT canonical_url, count(*) AS n
    FROM sources
    WHERE enabled = true AND canonical_url IS NOT NULL
    GROUP BY canonical_url
    HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE WARNING 'canonical_url duplicates in active pool: % groups — review before unique index', dup_count;
  END IF;
END $$;

-- 建唯一索引（只在没有重复时才建成功；有重复时会失败，由部署脚本处理）
CREATE UNIQUE INDEX IF NOT EXISTS sources_canonical_url_idx
  ON sources(canonical_url)
  WHERE enabled = true AND canonical_url IS NOT NULL;

-- ============================================================
-- STEP 4: reserve pool guard trigger
--   - policy 行 FOR UPDATE 序列化并发
--   - 互斥 1：source_id 不能同时在 active 池
--   - 互斥 2：source_id 对应的 canonical_url 不能与 active 池其他源重复
--   - 上限：非隔离、非归档的备用候选行总数 ≤ target_reserves
-- ============================================================
CREATE OR REPLACE FUNCTION reserve_pool_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  current_count integer;
  this_canonical text;
BEGIN
  -- 序列化：锁住 policy 单例行
  SELECT target_reserves INTO cap FROM source_registry_policy WHERE singleton FOR UPDATE;

  -- ---- 互斥 1：source_id 不能同时在 active 池 ----
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.source_id IS DISTINCT FROM OLD.source_id) THEN
    IF EXISTS(SELECT 1 FROM sources s WHERE s.id = NEW.source_id AND s.enabled = true) THEN
      RAISE EXCEPTION 'source % is already enabled in active pool — cannot also be a reserve', NEW.source_id USING ERRCODE='23514';
    END IF;
  END IF;

  -- ---- 互斥 2：canonical_url 不能与 active 池其他源重复 ----
  SELECT canonical_url INTO this_canonical FROM sources WHERE id = NEW.source_id;
  IF this_canonical IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM sources s
      WHERE s.canonical_url = this_canonical
        AND s.id != NEW.source_id
        AND s.enabled = true
    ) THEN
      RAISE EXCEPTION 'canonical_url % already used by another active source', this_canonical USING ERRCODE='23514';
    END IF;
  END IF;

  -- ---- 上限：非隔离、非归档的备用候选行总数 ----
  IF NEW.quarantined = false THEN
    IF NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = NEW.source_id) THEN
      SELECT count(*) INTO current_count
      FROM source_reserves r
      WHERE r.quarantined = false
        AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = r.source_id);
      IF TG_OP = 'UPDATE' AND OLD.quarantined = false THEN
        current_count := current_count - 1;
      END IF;
      IF current_count >= cap THEN
        RAISE EXCEPTION 'reserve pool capacity exhausted (% candidates >= %)', current_count, cap USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS reserve_pool_guard ON source_reserves;
CREATE TRIGGER reserve_pool_guard
  BEFORE INSERT OR UPDATE OF source_id, eligible, validated_at, quarantined ON source_reserves
  FOR EACH ROW EXECUTE FUNCTION reserve_pool_capacity_guard();

-- ============================================================
-- STEP 5: 正式启用时自动从备用池删除（互斥）
-- ============================================================
CREATE OR REPLACE FUNCTION source_enable_reserve_mutex() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled = true AND (TG_OP = 'INSERT' OR OLD.enabled = false) THEN
    DELETE FROM source_reserves WHERE source_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS source_enable_reserve_mutex ON sources;
CREATE TRIGGER source_enable_reserve_mutex
  AFTER INSERT OR UPDATE OF enabled ON sources
  FOR EACH ROW EXECUTE FUNCTION source_enable_reserve_mutex();

-- ============================================================
-- STEP 6: 刷新计数器 + 辅助函数
-- ============================================================
CREATE OR REPLACE FUNCTION refresh_reserve_count() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE source_registry_policy SET
    reserve_candidates_count = (
      SELECT count(*) FROM source_reserves r
      WHERE r.quarantined = false
        AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = r.source_id)
    ),
    reserve_fresh_count = (
      SELECT count(*) FROM source_reserves r
      WHERE r.eligible = true
        AND r.quarantined = false
        AND r.validated_at > now() - interval '7 days'
        AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = r.source_id)
    )
  WHERE singleton;
END $$;

-- 注意：生产已由 API 删除 3 行使 reserve_total=1000，不再自动 quarantine。
-- 如需手动隔离超额，运行 SELECT quarantine_reserve_overcap();
CREATE OR REPLACE FUNCTION quarantine_reserve_overcap() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  updated integer;
BEGIN
  SELECT target_reserves INTO cap FROM source_registry_policy WHERE singleton;
  WITH ranked AS (
    SELECT source_id,
           row_number() OVER (ORDER BY validated_at DESC, source_id) AS rn
    FROM source_reserves
    WHERE quarantined = false
      AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = source_reserves.source_id)
  )
  UPDATE source_reserves r
  SET quarantined = true,
      quarantine_reason = 'overcap: exceeds target_reserves=' || cap,
      validation = COALESCE(r.validation, '{}'::jsonb) || jsonb_build_object('overcapQuarantinedAt', now())
  FROM ranked
  WHERE r.source_id = ranked.source_id
    AND ranked.rn > cap
    AND r.quarantined = false;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;

SELECT refresh_reserve_count();
