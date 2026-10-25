-- Historical source rows keep article attribution; retired rows are outside the live registry.
ALTER TABLE source_registry_policy ADD COLUMN target_total integer CHECK (target_total IS NULL OR target_total >= target_enabled);
ALTER TABLE source_registry_policy ADD COLUMN automatic_failover boolean NOT NULL DEFAULT false;
CREATE TABLE source_retirements (
  source_id text PRIMARY KEY,
  source_snapshot jsonb NOT NULL,
  reason text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_reserves (
  source_id text PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  validated_at timestamptz NOT NULL,
  validation jsonb NOT NULL,
  eligible boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  priority integer NOT NULL DEFAULT 0
);
CREATE INDEX source_reserves_check_idx ON source_reserves(next_check_at);

-- Do not silently grow the pool through seed, ingest or manual creation once the operator sets it.
CREATE FUNCTION source_pool_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer;
BEGIN
  SELECT target_total INTO cap FROM source_registry_policy WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT 1 FROM source_retirements WHERE source_id=NEW.id) THEN
    RAISE EXCEPTION 'retired source must be explicitly reviewed before reuse' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND cap IS NOT NULL AND
     (SELECT count(*) FROM sources s WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id))>=cap THEN
    RAISE EXCEPTION 'source pool capacity exhausted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_pool_insert_guard BEFORE INSERT ON sources FOR EACH ROW EXECUTE FUNCTION source_pool_capacity_guard();
CREATE TRIGGER source_pool_enable_guard BEFORE UPDATE OF enabled ON sources FOR EACH ROW WHEN(NEW.enabled) EXECUTE FUNCTION source_pool_capacity_guard();
