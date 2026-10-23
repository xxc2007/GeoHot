-- Match the budget covering index already used in production, without dropping an existing index.
CREATE INDEX IF NOT EXISTS receipt_attempts_budget_idx
  ON receipt_attempts (service, origin, started_at) INCLUDE (billing_status);
-- Health reads need narrow status/model data, never the large saved provider response.
CREATE INDEX IF NOT EXISTS receipt_attempts_live_health_idx
  ON receipt_attempts (started_at DESC) INCLUDE (service,model,status,receipt_id,attempt)
  WHERE origin='live';
CREATE INDEX IF NOT EXISTS receipts_live_step_health_idx
  ON receipts (service,created_at) INCLUDE (model,purpose,status)
  WHERE origin='live';
