-- Durable evidence for the exact body renditions prepared by the worker; queue retention is irrelevant.
CREATE TABLE IF NOT EXISTS article_media_readiness (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  fingerprint text NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  renditions integer NOT NULL DEFAULT 0 CHECK (renditions >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  attempted_at timestamptz,
  queued_at timestamptz,
  prepared_at timestamptz
);
