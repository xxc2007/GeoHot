#!/usr/bin/env bash
# 大表的例行回收放在凌晨，而不是交给 autovacuum 在白天自己找时机。
#
# 2026-11-15 现场：`receipts` 2.8 GB / `receipt_attempts` 596 MB 上累积了 8 万多死元组，
# autovacuum 在下午自己触发，把一块 ~450 IOPS 的盘打到 `io some avg10=98.6`，
# 读者页从 40 ms 掉到 5 s，`/api/health` 的 DB 往返 7.4 秒。
#
# 2026-11-16 现场（第二幕）：这个「凌晨窗口」自己成了事故。手动 `VACUUM` **不读**
# autovacuum 的成本参数，`vacuum_cost_delay` 默认 0，于是它在 04:10 以满速读 2.8 GB，
# 跑了 1 小时 29 分，`io some avg10` 全程 99、load 30+、swap 用掉 880 MB，
# 读者面 `/all` 要 10 秒。三条护栏因此必须写在脚本里：
#   1) 进窗口前先看 io 压力，已经高的直接跳过，留给下一个窗口；
#   2) 用 PGOPTIONS 把 `vacuum_cost_delay` / `vacuum_cost_limit` 压上手动的 VACUUM，
#      让它自己让路给线上读；
#   3) `statement_timeout` 兜底，宁可这一晚不回收，也不许它跑几个小时。
set -euo pipefail

DATABASE="${GEOHOT_VACUUM_DB:-geohot}"
TABLES=(receipts receipt_attempts admin_model_attempt_metrics)
IO_LIMIT="${GEOHOT_VACUUM_MAX_IO:-60}"                                  # /proc/pressure/io some avg10 上限
STATEMENT_TIMEOUT_MS="${GEOHOT_VACUUM_STATEMENT_TIMEOUT_MS:-1800000}"   # 30 分钟
IO_FILE="${GEOHOT_VACUUM_IO_FILE:-/proc/pressure/io}"
RUN_AS="${GEOHOT_VACUUM_RUN_AS-postgres}"
PSQL_BIN="${GEOHOT_VACUUM_PSQL:-psql}"
PGOPTIONS_VALUE="-c vacuum_cost_delay=20 -c vacuum_cost_limit=200 -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=30s"

io_some_avg10() {
  awk -F'avg10=' '/^some/ {split($2, a, " "); print a[1] + 0; found = 1} END {if (!found) print 0}' "$IO_FILE" 2>/dev/null || echo 0
}

command -v "$PSQL_BIN" >/dev/null || { echo "psql not found: $PSQL_BIN" >&2; exit 1; }

# 手动 VACUUM 不读 autovacuum 的成本参数，必须用 PGOPTIONS 把让路的参数塞进去。
# 这里不拼数组命令：bash 4.2 下空数组 "${runner[@]}" 会展开成一个空词，报 ": command not found"。
run_vacuum() {
  local table="$1"
  if [ -n "$RUN_AS" ]; then
    sudo -u "$RUN_AS" env PGOPTIONS="$PGOPTIONS_VALUE" "$PSQL_BIN" -d "$DATABASE" -v ON_ERROR_STOP=1 \
      -c "VACUUM (ANALYZE, SKIP_LOCKED, VERBOSE) ${table}"
  else
    env PGOPTIONS="$PGOPTIONS_VALUE" "$PSQL_BIN" -d "$DATABASE" -v ON_ERROR_STOP=1 \
      -c "VACUUM (ANALYZE, SKIP_LOCKED, VERBOSE) ${table}"
  fi
}

for table in "${TABLES[@]}"; do
  io="$(io_some_avg10)"
  if awk -v a="$io" -v b="$IO_LIMIT" 'BEGIN {exit !(a >= b)}'; then
    echo "-- skip ${table}: io some avg10=${io} 已经到 ${IO_LIMIT}，留给下一个窗口"
    continue
  fi
  echo "== vacuum ${table} io=${io} ($(date -Is))"
  if ! run_vacuum "$table" 2>&1 | tail -3; then
    echo "-- ${table} 这次没回收完（超时或报错），下一个窗口再来"
  fi
done

echo "== done ($(date -Is))"
