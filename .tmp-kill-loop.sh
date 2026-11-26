#!/bin/bash
# 等 SSH 回来，然后把主库上两条病态查询体检-终止（只匹配两种形状，绝不碰读者查询）。
set -uo pipefail
K=/c/Users/理想与现实/.ssh/geohot_deploy_ed25519
H=xxc@20.194.28.128
until ssh -o BatchMode=yes -o ConnectTimeout=20 -i "$K" "$H" 'echo BACK' 2>/dev/null | grep -q BACK; do sleep 15; done
cat > /tmp/pgkill.sql <<'SQL'
\set ON_ERROR_STOP 1
SELECT pid, round(extract(epoch FROM now()-query_start)) AS secs, state,
       left(regexp_replace(coalesce(query,''),'\s+',' ','g'), 60) AS q
  FROM pg_stat_activity
 WHERE backend_type='client backend'
   AND ( (state='active' AND now()-query_start > interval '120 seconds' AND query ILIKE '%receipts r%' AND query ILIKE '%unknown%')
      OR (state='idle in transaction' AND now()-state_change > interval '120 seconds') );
SELECT count(pg_terminate_backend(pid)) AS killed
  FROM pg_stat_activity
 WHERE backend_type='client backend'
   AND ( (state='active' AND now()-query_start > interval '120 seconds' AND query ILIKE '%receipts r%' AND query ILIKE '%unknown%')
      OR (state='idle in transaction' AND now()-state_change > interval '120 seconds') );
SQL
scp -o BatchMode=yes -o ConnectTimeout=25 -i "$K" /tmp/pgkill.sql "$H":/tmp/pgkill.sql || exit 1
ssh -o BatchMode=yes -o ConnectTimeout=25 -i "$K" "$H" 'sudo -u postgres psql -d geohot -f /tmp/pgkill.sql 2>&1 | head -20; rm -f /tmp/pgkill.sql; uptime; free -m | sed -n 2p'
