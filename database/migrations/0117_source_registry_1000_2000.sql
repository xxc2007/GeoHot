-- 业主 2026-11-08：信源总量 2000，其中 1000 正式采集、1000 备用。
-- 只在「还停在 2000/2400 那个临时上限」时改：干净库的 target_enabled 是 NULL（非托管），
-- 那里新建信源默认启用，不能被这条迁移改成 1000 的口径。
UPDATE source_registry_policy
   SET target_enabled = 1000,
       target_total = 2000,
       reason = '业主 2026-11-08：总量 2000，其中 1000 正式采集、1000 备用',
       updated_at = now()
 WHERE singleton
   AND target_enabled = 2000;
