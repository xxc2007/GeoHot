-- Execution recovery is not a billing decision. Unknown attempts released for a retry must still
-- reserve spend capacity; only explicit evidence that an attempt was unbilled can release it.
-- Default unknown also keeps attempts written by an older binary conservative during an upgrade.
ALTER TABLE receipt_attempts
  ADD COLUMN billing_status text NOT NULL DEFAULT 'unknown'
  CHECK (billing_status IN ('reserved', 'unknown', 'billed', 'unbilled'));

-- Historical failed/usage-NULL rows include automatic and manual releases of unknown outcomes.
-- Error text and receipt-level audits cannot reliably identify which earlier attempt was free.
UPDATE receipt_attempts
SET billing_status = CASE
  WHEN status = 'received' OR cost > 0 THEN 'billed'
  WHEN status = 'pending' THEN 'reserved'
  ELSE 'unknown'
END;
