-- Backlog and recent failures need only narrow columns, not the stored job payloads.
DO $$ BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS job_admin_backlog_idx ON pgboss.job (name,state,created_on) WHERE state IN (''created'',''retry'',''active'')';
    EXECUTE 'CREATE INDEX IF NOT EXISTS job_admin_failed_idx ON pgboss.job (completed_on DESC,name) WHERE state = ''failed''';
  END IF;
END $$;
