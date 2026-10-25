-- Read-side cache measurements only. No receipt, billing, model pool or budget mutations.
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='5000ms';
ALTER TABLE admin_model_attempt_metrics ADD COLUMN tokens_cached bigint;
ALTER TABLE admin_model_attempt_metrics ADD COLUMN cache_checked boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION admin_metric_cached_tokens(value jsonb) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN hit <= admin_metric_token_count(value->'prompt_tokens') THEN hit END
  FROM (SELECT coalesce(
    admin_metric_token_count(value#>'{prompt_tokens_details,cached_tokens}'),
    admin_metric_token_count(value#>'{input_tokens_details,cached_tokens}'),
    admin_metric_token_count(value->'prompt_cache_hit_tokens'),
    admin_metric_token_count(value->'cached_tokens'),
    admin_metric_token_count(value->'cache_read_input_tokens')) AS hit) s
$$;
CREATE OR REPLACE FUNCTION maintain_admin_model_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admin_model_attempt_metrics(id,receipt_id,started_at,origin,model,status,latency_ms,tokens_in,tokens_out,cost,cost_basis,currency,tokens_cached,cache_checked)
  VALUES(NEW.id,NEW.receipt_id,NEW.started_at,NEW.origin,NEW.model,NEW.status,NEW.latency_ms,
    admin_metric_token_count(NEW.usage->'prompt_tokens'),admin_metric_token_count(NEW.usage->'completion_tokens'),NEW.cost,NEW.cost_basis,NEW.currency,
    admin_metric_cached_tokens(NEW.usage),true)
  ON CONFLICT(id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,started_at=EXCLUDED.started_at,origin=EXCLUDED.origin,
    model=EXCLUDED.model,status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,tokens_in=EXCLUDED.tokens_in,
    tokens_out=EXCLUDED.tokens_out,cost=EXCLUDED.cost,cost_basis=EXCLUDED.cost_basis,currency=EXCLUDED.currency,
    tokens_cached=EXCLUDED.tokens_cached,cache_checked=true;
  RETURN NEW;
END;
$$;
INSERT INTO settings(key,value,updated_by)
SELECT 'admin.usageCacheReady',to_jsonb(NOT EXISTS(SELECT 1 FROM admin_model_attempt_metrics WHERE NOT cache_checked)),'migration:0089'
ON CONFLICT(key) DO NOTHING;
