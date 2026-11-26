#!/bin/bash
# Reader guard: terminate long English-backfill scans that starve the reader DB.
# Only matches the two sweep query shapes (english_attempts / translations join) and only after 60s,
# so ordinary reader queries are never touched. Installed as geohot-reader-guard.timer (every 2 minutes).
set -uo pipefail
LOG=/var/log/geohot-reader-guard.log
exec >>"$LOG" 2>&1

killed=$(sudo -u postgres psql -d geohot -At -c "
  select count(*)
  from (select pg_terminate_backend(pid) as ok
        from pg_stat_activity
        where state = 'active'
          and backend_type = 'client backend'
          and now() - query_start > interval '60 seconds'
          and (query ilike '%english_attempts%' or query ilike '%translations tr%')) t
  where ok" 2>/dev/null | tr -d '[:space:]')

if [ "${killed:-0}" != "0" ]; then
  echo "$(date -Is) killed=${killed} english-backfill queries >60s"
fi
