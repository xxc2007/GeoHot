-- Multi-engine source discovery: search results are evidence, not registry rows.
-- Candidates live here until an operator approves one; approving still has to pass the
-- existing source-pool capacity guard. This keeps discovery from silently shrinking or
-- reshaping the live pool.
CREATE TABLE IF NOT EXISTS source_discovery_runs (
  id text PRIMARY KEY,
  query text NOT NULL,
  category text,
  engines text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS source_discovery_runs_started_idx ON source_discovery_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS source_discovery_candidates (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES source_discovery_runs(id) ON DELETE CASCADE,
  address text NOT NULL,
  feed_url text,
  host text NOT NULL,
  name text,
  title text,
  engines jsonb NOT NULL DEFAULT '[]'::jsonb,
  corroboration integer NOT NULL DEFAULT 0,
  quality integer NOT NULL DEFAULT 0,
  verdict jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  source_id text,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (run_id, feed_url)
);
CREATE INDEX IF NOT EXISTS source_discovery_candidates_pending_idx
  ON source_discovery_candidates(status, quality DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS source_discovery_candidates_host_idx
  ON source_discovery_candidates(host);
