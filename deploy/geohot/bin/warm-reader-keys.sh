#!/bin/bash
# Warm the reader keys so their disk snapshots and in-process caches exist.
# The API serves `timeline`/`pool` from a snapshot once one has been written; before that, every cold
# key pays a full computation (13–120 s on the 250-IOPS disk) and the SSR request times out at 16 s.
# This is what turned /geohot/en/ from 2/10 to 10/10: geohot-warm-keys.timer runs it every 10 minutes.
set -uo pipefail
LOG=/var/log/geohot-warm-en.log
exec >>"$LOG" 2>&1
B=http://127.0.0.1:3001
echo "=== $(date -Is) warm start ==="
for p in \
  "timeline?lang=en&limit=40" \
  "pool?lang=en&page=1" \
  "topics?lang=en" \
  "hot?lang=en" \
  "stats?lang=en" \
  "timeline?lang=zh&limit=40" \
  "pool?lang=zh&page=1" \
  "topics?lang=zh" \
  "stats?lang=zh" ; do
  code=$(curl -s -o /dev/null -w "%{http_code} %{time_total}s" --max-time 300 "$B/api/site/$p")
  echo "$p -> $code"
done
echo "=== $(date -Is) warm done ==="
