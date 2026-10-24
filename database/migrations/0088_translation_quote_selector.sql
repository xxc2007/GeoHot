-- Quote translation only needs selected full-text X posts in its discovery window.
-- Without this slice, even an empty queue reads the broader publication heap.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5000ms';
CREATE INDEX IF NOT EXISTS publications_translation_quote_idx
  ON publications(discovered_at DESC,article_id)
  WHERE channel='x' AND selected AND visibility='public' AND body_mode='full';
