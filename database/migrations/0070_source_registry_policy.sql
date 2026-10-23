-- Optional capacity policy. NULL preserves existing/new-install behavior; never enable 666 here.
-- Installation takes the source write lock so initialization cannot miss a concurrent source write.
LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE source_registry_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  target_enabled integer CHECK (target_enabled IS NULL OR target_enabled >= 0),
  enabled_count integer NOT NULL CHECK (enabled_count >= 0),
  policy_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  reason text,
  CONSTRAINT source_registry_capacity CHECK (target_enabled IS NULL OR enabled_count <= target_enabled)
);
INSERT INTO source_registry_policy(singleton,enabled_count) SELECT true,count(*) FROM sources WHERE enabled;

-- Acquire policy BEFORE source tuple locks for every statement able to alter capacity.
CREATE FUNCTION source_registry_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source_registry_policy WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source registry policy missing'; END IF;
  IF TG_OP = 'TRUNCATE' AND (SELECT target_enabled IS NOT NULL FROM source_registry_policy WHERE singleton) THEN
    RAISE EXCEPTION 'managed source registry cannot be truncated' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER source_registry_insert_lock BEFORE INSERT ON sources FOR EACH STATEMENT EXECUTE FUNCTION source_registry_lock();
CREATE TRIGGER source_registry_delete_lock BEFORE DELETE ON sources FOR EACH STATEMENT EXECUTE FUNCTION source_registry_lock();
CREATE TRIGGER source_registry_update_lock BEFORE UPDATE OF enabled ON sources FOR EACH STATEMENT EXECUTE FUNCTION source_registry_lock();
CREATE TRIGGER source_registry_truncate_lock BEFORE TRUNCATE ON sources FOR EACH STATEMENT EXECUTE FUNCTION source_registry_lock();

CREATE FUNCTION source_registry_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta integer;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    UPDATE source_registry_policy SET enabled_count=0,updated_at=now() WHERE singleton;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN delta := CASE WHEN NEW.enabled THEN 1 ELSE 0 END;
  ELSIF TG_OP = 'DELETE' THEN delta := CASE WHEN OLD.enabled THEN -1 ELSE 0 END;
  ELSE delta := (NEW.enabled::integer)-(OLD.enabled::integer);
  END IF;
  IF delta <> 0 THEN
    UPDATE source_registry_policy SET enabled_count=enabled_count+delta,updated_at=now() WHERE singleton;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER source_registry_insert_count AFTER INSERT ON sources FOR EACH ROW EXECUTE FUNCTION source_registry_count();
CREATE TRIGGER source_registry_delete_count AFTER DELETE ON sources FOR EACH ROW EXECUTE FUNCTION source_registry_count();
CREATE TRIGGER source_registry_update_count AFTER UPDATE OF enabled ON sources FOR EACH ROW EXECUTE FUNCTION source_registry_count();
CREATE TRIGGER source_registry_truncate_count AFTER TRUNCATE ON sources FOR EACH STATEMENT EXECUTE FUNCTION source_registry_count();

-- Private evidence, never a public article/source or an instruction to a model. Repeats are bounded.
CREATE TABLE ingest_source_submissions (
  id bigserial PRIMARY KEY,
  requested_source_id text NOT NULL CHECK (length(requested_source_id) BETWEEN 1 AND 120),
  client text NOT NULL CHECK (length(client) BETWEEN 1 AND 120),
  payload_hash text NOT NULL CHECK (length(payload_hash)=64),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 1048576),
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  review_reason text,
  linked_source_id text REFERENCES sources(id) ON DELETE SET NULL,
  UNIQUE(requested_source_id,client,payload_hash)
);
