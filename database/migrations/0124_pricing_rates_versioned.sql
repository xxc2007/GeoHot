-- 官方价卡版本化：硬编码常量只作 seed/兜底，真实行由异步 pricing-check timer 落库。
-- 不在页面请求时打外网；页面只读最新一行。stale=true 表示距 fetched_at 超过复核周期，前端应提示。
CREATE TABLE IF NOT EXISTS pricing_rates (
  id            text PRIMARY KEY,           -- 与 OFFICIAL_RATES.id 对齐，如 deepseek/glm53flash
  name          text NOT NULL,
  currency      text NOT NULL CHECK (currency IN ('USD','CNY')),
  input_price   numeric(14,6) NOT NULL,     -- 每 1M token
  cached_price  numeric(14,6) NOT NULL,
  output_price  numeric(14,6) NOT NULL,
  billing_kind  text NOT NULL DEFAULT 'actual'
                CHECK (billing_kind IN ('actual','subscription','free','no-price')),
  source_url    text,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  fetched_at    timestamptz,
  stale         boolean NOT NULL DEFAULT true,  -- 未复核前视为 stale
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 不编造新价格：seed 只把现有已核验的 9 条常量落库，标记 fetched_at=已核验日、stale=false。
-- 后续官方研究返回新价时由 timer 走 upsert，不改本文件。
INSERT INTO pricing_rates (id,name,currency,input_price,cached_price,output_price,billing_kind,source_url,fetched_at,stale,note) VALUES
  ('deepseek','DeepSeek V4.1 Flash','USD',0.15,0.003,0.60,'actual','https://api-docs.deepseek.com/quick_start/pricing','2026-10-31',false,'谷时单价；峰谷由 peakFactor 应用'),
  ('hy3','腾讯 HY3','CNY',1,0.25,4,'actual','https://cloud.tencent.com/document/product/1823/130055','2026-10-31',false,'WorkBuddy 套餐实际扣费另计'),
  ('glm53flash','GLM-5.3-Flash 国内版','CNY',0.8,0.23,2.8,'actual','https://docs.bigmodel.cn/cn/guide/start/pricing','2026-10-31',false,'智谱中国站'),
  ('glm53flash-intl','GLM-5.3-Flash 国际版','USD',0.15,0.03,0.50,'actual','https://docs.z.ai/guides/overview/pricing','2026-10-31',false,'Z.AI 国际站'),
  ('step5','Step 5 Preview','USD',1,0.1,2.7,'actual','https://platform.stepfun.ai/docs/en/guides/pricing/details','2026-10-31',false,'国际 API'),
  ('minimax','MiniMax M3.1 Flash','USD',0.15,0.015,0.60,'actual','https://www.minimax.io/blog/minimax-m31f','2026-10-31',false,'MiniMax Code 订阅另计'),
  ('dots','Dots3 Note Preview','USD',0.14,0.14,0.28,'actual','https://dots.ai/platform/docs','2026-10-31',false,'缓存按普通输入'),
  ('agnes','Agnes 3.0 Flash 国际版','USD',0.05,0.005,0.15,'actual','https://wiki.agnes-ai.com/en/docs/pricing','2026-10-31',false,'不应用免费体验'),
  ('agnes-cn','Agnes 3.0 Flash 国内版','CNY',0.35,0.035,1,'actual','https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash','2026-10-31',false,'国内版')
ON CONFLICT (id) DO NOTHING;
