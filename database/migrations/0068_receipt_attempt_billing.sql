-- Execution recovery is not a billing decision. Unknown attempts released for a retry must still
-- reserve spend capacity; only explicit evidence that an attempt was unbilled can release it.
-- Default unknown also keeps attempts written by an older binary conservative during an upgrade.
ALTER TABLE receipt_attempts
  ADD COLUMN billing_status text NOT NULL DEFAULT 'unknown';

-- Historical labels stay unknown: unknown/reserved/billed all reserve exactly the same budget.
-- Avoid rewriting hundreds of thousands of attempts or validating them during this tiny-host DDL.
-- NOT VALID still checks every new/changed row. Validation can be run separately in a quiet window;
-- neither validation nor optional historical label refinement is required for conservative accounting.
ALTER TABLE receipt_attempts
  ADD CONSTRAINT receipt_attempts_billing_status_check
  CHECK (billing_status IN ('reserved', 'unknown', 'billed', 'unbilled')) NOT VALID;
