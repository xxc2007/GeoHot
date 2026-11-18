-- 官方价卡版本化（2026-11-18 重写，未发布可替换）。
-- 红线：
--   * actual 成本只来自回执 cost（receipt_attempts.cost_basis='actual'），本表任何刊例/等值价都不是 actual 账单。
--   * 无公开价/订阅/免费/未核实条目费率列存 NULL，绝不按 0 计价。
--   * 页面只读 DB，不在请求时打外网；HTTP 200 不能冒充价已核验（fetched_at/last_success_at 只在解析成功后更新）。
-- 历史版本：调用按 started_at 选当时有效价卡；当前行存最新，versions 表留每次生效快照。

CREATE TABLE IF NOT EXISTS pricing_rates (
  id                 text PRIMARY KEY,                  -- service::upstream_model
  service            text NOT NULL,
  model              text NOT NULL,
  name               text,
  currency           text CHECK (currency IN ('USD','CNY') OR currency IS NULL),
  unit               text,
  -- 多维档位（list/off-peak/peak/promo…）JSON；基准单价取 tiers.list 或首档。可为空。
  tiers              jsonb,
  input_price        numeric(14,6),                     -- 每 1M token，NULL=未计价，禁止当 0
  cached_price       numeric(14,6),
  output_price       numeric(14,6),
  billing_kind       text NOT NULL DEFAULT 'no-price'
                     CHECK (billing_kind IN
                       ('actual','equivalent-public-api','subscription','free','no-price','unverified')),
  source_urls        jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url         text,
  effective_at       timestamptz,                       -- 该价生效时点；历史调用按 started_at 选行
  fetched_at         timestamptz,                       -- 最近一次解析成功并落库的时点
  last_attempt_at    timestamptz,                       -- 最近一次尝试（含失败）；HTTP 200 本身不更新 fetched_at
  last_success_at    timestamptz,
  last_error         text,
  stale              boolean NOT NULL DEFAULT true,
  note               text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 每次有效价变更留一条历史快照；同 id 多版本按 effective_at 回溯。
CREATE TABLE IF NOT EXISTS pricing_rate_versions (
  id           bigserial PRIMARY KEY,
  rate_id      text NOT NULL REFERENCES pricing_rates(id) ON DELETE CASCADE,
  service      text NOT NULL,
  model        text NOT NULL,
  currency     text,
  tiers        jsonb,
  input_price  numeric(14,6),
  cached_price numeric(14,6),
  output_price numeric(14,6),
  billing_kind text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  fetched_at   timestamptz,
  note         text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pricing_rate_versions_rate_eff
  ON pricing_rate_versions(rate_id, effective_at DESC);

-- seed 数据来自仓库 database/seeds/pricing/map-{A,B,C}.json（47 条官方研究映射），
-- 由 tooling/seed-pricing-rates.ts 在部署/启动时 upsert；SQL 这里不内联伪 actual 价。
