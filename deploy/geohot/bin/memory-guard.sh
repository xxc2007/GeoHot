#!/usr/bin/env bash
# 891 MB 的主库会自己把自己打死，而且不需要任何外部事故。
#
# 2026-11-16 的两幕现场（同一天、两次）：
#   · 12:0x  `io some avg10=99`、`load 33`、`/api/health` 要 274 秒、后台登录 504；
#            而 `ps` 里 CPU 最高的进程只有 5%，`/proc/<pid>/io` 3 秒差分没有任何进程
#            读盘超过 0.3 MB/s —— 盘不是被谁读死的，是内核在替换出的页找地方。
#   · 12:3x  `free -m` 显示 `Swap 2047 total / 833 used`、`/proc/pressure/memory` 的
#            `full avg10=96`；`sysctl -w vm.swappiness=1` + 重启 api/web 之后
#            `io some avg10` 从 98.57 掉到 7.02、`health` 从 6.9–17.6 s 掉到 0.0056 s。
#
# 结论：这台机器上「重启长跑进程」等于「把它被换出的页收回来」，是最快的一招。
# 这个脚本就是把它自动化：内存压力到线就重启 api 与 web，并把原因写进 journal。
# 刻意只动这两个单元——worker/media 由 R115 与 readers-only 管，这里不越权。
set -euo pipefail

PRESSURE_FILE="${GEOHOT_MEM_GUARD_PRESSURE_FILE:-/proc/pressure/memory}"
MEMINFO_FILE="${GEOHOT_MEM_GUARD_MEMINFO:-/proc/meminfo}"
STATE_FILE="${GEOHOT_MEM_GUARD_STATE:-/run/geohot-memory-guard.at}"
FULL_LIMIT="${GEOHOT_MEM_GUARD_FULL_AVG10:-40}"     # /proc/pressure/memory full avg10 上限
SWAP_LIMIT="${GEOHOT_MEM_GUARD_SWAP_PCT:-60}"       # swap 使用率上限（%）
COOLDOWN="${GEOHOT_MEM_GUARD_COOLDOWN_SEC:-1800}"   # 两次重启之间至少隔 30 分钟
DRY="${GEOHOT_MEM_GUARD_DRY:-0}"
SYSTEMCTL="${GEOHOT_MEM_GUARD_SYSTEMCTL:-systemctl}"
UNITS=(geohot-api geohot-web)

full_avg10() {
  [ -r "$PRESSURE_FILE" ] || { echo 0; return; }
  awk -F'avg10=' '/^full/ {split($2, a, " "); print a[1]; found=1} END {if (!found) print 0}' "$PRESSURE_FILE"
}

swap_pct() {
  [ -r "$MEMINFO_FILE" ] || { echo 0; return; }
  awk '/^SwapTotal:/ {total=$2} /^SwapFree:/ {free=$2} END {
    if (total == 0) {print 0} else {printf "%d", (total - free) * 100 / total}
  }' "$MEMINFO_FILE"
}

full=$(full_avg10)
swap=$(swap_pct)
# /proc/pressure 给的是两位小数（例如 96.00），bash 的 [ -lt ] 只吃整数，先截断再比。
full_iv=${full%%.*}
case "$full_iv" in ''|*[!0-9]*) full_iv=0 ;; esac

if [ "$full_iv" -lt "$FULL_LIMIT" ] && [ "$swap" -lt "$SWAP_LIMIT" ]; then
  echo "ok full=$full_iv swap=${swap}% (线 ${FULL_LIMIT}/${SWAP_LIMIT}%)"
  exit 0
fi

now=$(date +%s)
last=0
[ -r "$STATE_FILE" ] && last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  echo "pressured full=$full_iv swap=${swap}% 但 $((now - last)) 秒前刚重启过，等冷却"
  exit 0
fi

echo "pressured full=$full_iv swap=${swap}%：重启 ${UNITS[*]} 收回被换出的页"
if [ "$DRY" != "1" ]; then
  for unit in "${UNITS[@]}"; do
    "$SYSTEMCTL" restart "$unit" || echo "重启 $unit 失败" >&2
  done
  echo "$now" > "$STATE_FILE" 2>/dev/null || true
fi
echo "done full=$full_iv swap=$(swap_pct)%"
