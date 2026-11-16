-- Hotfix: append-only audit trail for the body backflow (hidden / reprocessed / restored / failed).
--
-- The 2026-11-16 incident changed four production rows to visibility='summary-only' by hand, which made
-- their detail pages 404. The repair backfill (scripts/repair-body-publication.ts) must record, per
-- article, every state transition it causes, with the rule version and reasons that justified it, so a
-- later review can answer "why is this hidden / why was this restored / why did this stay defective".
--
-- This table never gates a reader request; it is the operator-facing ledger.

CREATE TABLE IF NOT EXISTS publication_body_repair_log (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('hidden', 'reprocessed', 'restored', 'failed')),
  reasons text[] NOT NULL DEFAULT '{}',
  rule_version text,
  from_visibility text,
  to_visibility text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS publication_body_repair_log_article_idx
  ON publication_body_repair_log (article_id, created_at DESC);

CREATE INDEX IF NOT EXISTS publication_body_repair_log_created_idx
  ON publication_body_repair_log (created_at DESC);
