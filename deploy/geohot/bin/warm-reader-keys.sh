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
# 2026-11-27：首页请求的是 `limit=12`（apps/web/app/routes/home.tsx:56 的 `queryString({...scope, limit: 12})`），
# 而这里一直只热 `limit=40` —— `/api/site/timeline` 的落盘底稿键含 limit（apps/api/src/routes/site.ts:213 的
# staleKey），两把键不相等，所以定时器从来没有为首页写过 `tl:` 底稿。
# 收益要说准：内存里锚点聚合快照的键是 `binding(q)`、不含 limit（packages/backend/src/publication/timeline.ts:32-35，
# 缓存用键在 :90），所以 limit=40 的预热确实已经替首页热到了锚点聚合这一段，不是全冷。
# 真正缺的是按 limit 取页的那截——members/pool/facts/水合（timeline.ts:160-169）——以及进程重启后
# 「先读落盘底稿直出」那条快路径（site.ts:219-227）：没有 limit=12 的 `tl:` 键，重启后首页只能现算。
# 首页那两把键因此要一起热。
for p in \
  "timeline?lang=en&limit=12" \
  "timeline?lang=zh&limit=12" \
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
