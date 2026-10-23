-- Derived read model only. Provider responses, billing and request identities stay in their ledger.
CREATE TABLE IF NOT EXISTS admin_model_attempt_metrics (
  id bigint PRIMARY KEY REFERENCES receipt_attempts(id) ON DELETE CASCADE,
  receipt_id bigint,
  started_at timestamptz NOT NULL,
  origin text NOT NULL,
  model text,
  status text NOT NULL,
  latency_ms integer,
  tokens_in bigint,
  tokens_out bigint,
  cost numeric,
  cost_basis text,
  currency text
);
CREATE OR REPLACE FUNCTION maintain_admin_model_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admin_model_attempt_metrics(id,receipt_id,started_at,origin,model,status,latency_ms,tokens_in,tokens_out,cost,cost_basis,currency)
  VALUES(NEW.id,NEW.receipt_id,NEW.started_at,NEW.origin,NEW.model,NEW.status,NEW.latency_ms,
    (NEW.usage->>'prompt_tokens')::bigint,(NEW.usage->>'completion_tokens')::bigint,NEW.cost,NEW.cost_basis,NEW.currency)
  ON CONFLICT(id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,started_at=EXCLUDED.started_at,origin=EXCLUDED.origin,
    model=EXCLUDED.model,status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,tokens_in=EXCLUDED.tokens_in,
    tokens_out=EXCLUDED.tokens_out,cost=EXCLUDED.cost,cost_basis=EXCLUDED.cost_basis,currency=EXCLUDED.currency;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER receipt_attempts_admin_metrics
AFTER INSERT OR UPDATE OF receipt_id,started_at,origin,model,status,latency_ms,usage,cost,cost_basis,currency
ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION maintain_admin_model_metrics();
CREATE INDEX IF NOT EXISTS admin_model_metrics_started_idx ON admin_model_attempt_metrics(started_at DESC) WHERE origin='live';
INSERT INTO settings(key,value,updated_by)
SELECT 'admin.modelMetricsReady',to_jsonb(NOT EXISTS(SELECT 1 FROM receipt_attempts)),'migration'
ON CONFLICT(key) DO NOTHING;
