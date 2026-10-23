-- Existing ledgers must finish the derived-label backfill before expensive statistics resume.
INSERT INTO settings(key,value,updated_by)
VALUES('admin.modelLabelsReady',to_jsonb(NOT EXISTS(SELECT 1 FROM receipts LIMIT 1)),'migration:0082')
ON CONFLICT(key) DO NOTHING;
