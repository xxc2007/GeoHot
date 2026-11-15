#!/bin/bash
# 执行器的昼夜档：白天只采集，夜里才开分析。
#
# 为什么需要它：2026-11-15 在主库（891 MB / 2 vCPU / 单块 ~250 IOPS 的盘）上实测，
# 只要有任何分析并发，`/proc/pressure/io` 立刻回到 99%，读者面从 6 ms 掉到 5–15 秒，
# 甚至直接 000。采集（sources.fetch）是网络活、几乎不写库，可以白天一直跑；
# 分析（content.analyze）是重写 + 大扫，只能等夜里读者少的时候做。
#
# 用法：role-window.sh day|night [env 文件]
#   day   → WORKER_ROLE=all，分析槽 0（采集与正文提取照跑）
#   night → WORKER_ROLE=all，分析槽 2（三台执行器各 2 槽：夜里 6 个并发，白天 0）
#
# 为什么白天也写 WORKER_ROLE=all：`extraction` 在 worker-role.ts 里是
# `role !== coordinator && role !== fetcher && role !== media` —— 写成 fetcher 会把
# 「正文提取」一起关掉。2026-11-15 白天三台云机全切 fetcher，6 小时里堆下 420 条
# `body_status=pending`，读者面因此只剩标题。白天真正要停的只有分析，靠
# `GEOHOT_INTAKE_ANALYSIS_SLOTS=0` 拦（intake 按 analysis 车道单独计数）。
#
# 另一个坑：`ANALYZE_CONCURRENCY=0` 会被 config 当成「不是正整数」回落到 6/4，
# 反而把分析开大。所以这两个键都写 1，用 slots 决定开不开分析。
set -u

mode="${1:-day}"
env_file="${2:-/opt/geohot-exec/.env}"

case "$mode" in
  day)   role=all; slots=0 ;;
  night) role=all; slots=2 ;;
  *) echo "用法：$0 day|night [env 文件]" >&2; exit 2 ;;
esac

if [ ! -f "$env_file" ]; then
  echo "找不到 $env_file" >&2
  exit 1
fi

# 先备份再改：这几个键曾经被 systemd drop-in 盖掉过，出问题时能一眼对比回来。
cp -p "$env_file" "$env_file.bak-role-$(date +%H%M%S)"

set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_key WORKER_ROLE "$role"
# 恒定写 1：写 0 会被当成非法值回落到 6/4，反而把分析开大。
set_key ANALYZE_CONCURRENCY "1"
set_key GEOHOT_INTAKE_ANALYSIS_SLOTS "$slots"

logger -t geohot-role "mode=$mode role=$role slots=$slots file=$env_file"

# worker 要重启才会读到新的 role（job 分组在启动时决定）。
systemctl restart --no-block geohot-exec-worker 2>/dev/null || systemctl restart --no-block geohot-worker 2>/dev/null || true
echo "mode=$mode role=$role slots=$slots"
