-- Reasoning (hidden-chain) token read-side measurement only.
-- 红线：
--   * 只派生到 admin_model_attempt_metrics 派生读模型，不回写回执、不改账单/预算/价卡。
--   * reasoning tokens 仅展示口径；若上游 completion_tokens 已含 reasoning，成本不叠加、不重复计费。
--   * 缺 reasoning 字段的行保持 NULL，不计 0；缺失数由用量聚合另行统计。
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='5000ms';

ALTER TABLE admin_model_attempt_metrics ADD COLUMN IF NOT EXISTS tokens_reasoning bigint;

-- 兼容 OpenAI（completion_tokens_details.reasoning_tokens）、直传 reasoning_tokens、
-- Anthropic 风格 output_tokens_details.reasoning_tokens 三种常见位置；取不到返回 NULL。
CREATE OR REPLACE FUNCTION admin_metric_reasoning_tokens(value jsonb) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    admin_metric_token_count(value#>'{completion_tokens_details,reasoning_tokens}'),
    admin_metric_token_count(value#>'{output_tokens_details,reasoning_tokens}'),
    admin_metric_token_count(value->'reasoning_tokens'),
    admin_metric_token_count(value#>'{completion_tokens_details,reasoning}'))
$$;

CREATE OR REPLACE FUNCTION maintain_admin_model_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admin_model_attempt_metrics(id,receipt_id,started_at,origin,model,status,latency_ms,tokens_in,tokens_out,cost,cost_basis,currency,tokens_cached,cache_checked,tokens_reasoning)
  VALUES(NEW.id,NEW.receipt_id,NEW.started_at,NEW.origin,NEW.model,NEW.status,NEW.latency_ms,
    admin_metric_token_count(NEW.usage->'prompt_tokens'),admin_metric_token_count(NEW.usage->'completion_tokens'),NEW.cost,NEW.cost_basis,NEW.currency,
    admin_metric_cached_tokens(NEW.usage),true,admin_metric_reasoning_tokens(NEW.usage))
  ON CONFLICT(id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,started_at=EXCLUDED.started_at,origin=EXCLUDED.origin,
    model=EXCLUDED.model,status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,tokens_in=EXCLUDED.tokens_in,
    tokens_out=EXCLUDED.tokens_out,cost=EXCLUDED.cost,cost_basis=EXCLUDED.cost_basis,currency=EXCLUDED.currency,
    tokens_cached=EXCLUDED.tokens_cached,cache_checked=true,tokens_reasoning=EXCLUDED.tokens_reasoning;
  RETURN NEW;
END;
$$;

-- 一次性回填：从历史回执 usage 补派生行（只写派生表，不动回执/账单）。
UPDATE admin_model_attempt_metrics m
SET tokens_reasoning = admin_metric_reasoning_tokens(r.usage)
FROM receipt_attempts r
WHERE m.id = r.id AND m.tokens_reasoning IS NULL;

INSERT INTO settings(key,value,updated_by)
SELECT 'admin.reasoningTokensBackfilled',to_jsonb(true),'migration:0125'
ON CONFLICT(key) DO NOTHING;
