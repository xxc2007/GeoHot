#!/usr/bin/env bash
# 大表的例行回收放在凌晨，而不是交给 autovacuum 在白天自己找时机。
#
# 2026-11-15 现场：`receipts` 2.8 GB / `receipt_attempts` 596 MB 上累积了 8 万多死元组，
# autovacuum 在下午自己触发，把一块 ~450 IOPS 的盘打到 `io some avg10=98.6`，
# 读者页从 40 ms 掉到 5 s，`/api/health` 的 DB 往返 7.4 秒。
# 取消那一次 autovacuum 之后 io 立刻回到 2.76。
#
# 所以：表上把 autovacuum 的阈值调高、成本上限调低（让它极少自己动手），
# 真正的回收交给这个每天 04:10 的窗口，用 SKIP_LOCKED 避免跟线上读写抢锁。
set -euo pipefail

DATABASE="${GEOHOT_VACUUM_DB:-geohot}"
TABLES=(receipts receipt_attempts admin_model_attempt_metrics)

command -v psql >/dev/null || { echo "psql not found" >&2; exit 1; }

for table in "${TABLES[@]}"; do
  echo "== vacuum ${table} ($(date -Is))"
  sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 \
    -c "VACUUM (ANALYZE, SKIP_LOCKED, VERBOSE) ${table}" 2>&1 | tail -3
done

echo "== done ($(date -Is))"
