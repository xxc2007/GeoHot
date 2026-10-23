-- The source list counts selected publications per source without scanning the full ledger per row.
CREATE INDEX IF NOT EXISTS publications_selected_source_discovered_idx
  ON publications (source_id, discovered_at DESC) WHERE selected;
