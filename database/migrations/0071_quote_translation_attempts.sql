-- Per exact quoted text, not per parent article. Preserve receipts and original quoted content.
CREATE TABLE quote_translation_attempts (
  tweet_id text NOT NULL,
  text_hash text NOT NULL CHECK (length(text_hash)=64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  outcome text NOT NULL CHECK (outcome IN ('failed','deferred','skipped','translated')),
  reason text,
  last_checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tweet_id,text_hash)
);
