-- Admin totals must not read the wide receipts heap or saved provider answers.
CREATE INDEX IF NOT EXISTS receipts_admin_created_status_idx
  ON receipts (created_at DESC) INCLUDE (status);
CREATE INDEX IF NOT EXISTS job_runs_admin_started_idx
  ON job_runs (started_at DESC) INCLUDE (job,status);
