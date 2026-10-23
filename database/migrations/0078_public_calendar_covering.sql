-- Calendar/day totals previously scanned the wide publication heap after historical import.
-- The Chinese-copy predicate matches contracts/copy and is used with actual custom-plan parameters.
CREATE INDEX publications_calendar_zh_idx ON publications (timeline_at)
  INCLUDE (selected,visible_after,category,channel)
  WHERE visibility='public' AND eligible AND published_at IS NOT NULL AND title ~ '[一-鿿]';
