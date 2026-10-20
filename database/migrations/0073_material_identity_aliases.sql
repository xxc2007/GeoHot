-- Additive only: no existing article, receipt, publication or source is rewritten.
CREATE TABLE article_identity_aliases (
  alias_key text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  evidence_kind text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_identity_aliases_article_idx ON article_identity_aliases(article_id);
CREATE TABLE material_identity_conflicts (
  id bigserial PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  alias_keys text[] NOT NULL,
  article_ids text[] NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE material_observations (
  id bigserial PRIMARY KEY,
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  conflict_id bigint REFERENCES material_identity_conflicts(id),
  source_id text NOT NULL,
  via text NOT NULL CHECK(via IN ('fetch','ingest','import')),
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  observation_key text NOT NULL UNIQUE,
  CHECK ((article_id IS NULL) <> (conflict_id IS NULL))
);
CREATE INDEX material_observations_article_idx ON material_observations(article_id);
