-- Frequent receipt state changes clear visibility-map bits. Keep the narrow admin index truly cheap.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5000ms';
ALTER TABLE receipts SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);
