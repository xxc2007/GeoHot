-- Store only the small labels needed by admin model statistics. The request/response ledger and
-- request identity remain untouched. Historical rows are filled by backfill-admin-model-labels.ts
-- in separately committed batches; readers detect gaps instead of publishing incomplete totals.
CREATE TABLE IF NOT EXISTS receipt_model_labels (
  receipt_id bigint PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  service text NOT NULL,
  prompt_version text
);

CREATE OR REPLACE FUNCTION maintain_receipt_model_labels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO receipt_model_labels(receipt_id,purpose,service,prompt_version)
  VALUES(NEW.id,NEW.purpose,NEW.service,NEW.request->>'promptVersion')
  ON CONFLICT(receipt_id) DO UPDATE SET
    purpose=EXCLUDED.purpose,service=EXCLUDED.service,prompt_version=EXCLUDED.prompt_version;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER receipts_model_labels_insert
AFTER INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION maintain_receipt_model_labels();
CREATE OR REPLACE TRIGGER receipts_model_labels_update
AFTER UPDATE OF request,purpose,service ON receipts
FOR EACH ROW EXECUTE FUNCTION maintain_receipt_model_labels();
