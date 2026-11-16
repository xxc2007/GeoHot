#!/bin/bash
# 把执行器的昼夜档收敛到一套机制上，并装好它需要的脚本。
#
# 2026-11-16 的现场：杭州与武汉两台机器上同时躺着三套昼夜机制——
#   1) geohot-exec-window-{day,night}.timer → /usr/local/bin/geohot-exec-window.sh（旧，写 drop-in）
#   2) geohot-bg-{day,night}.timer          → /usr/local/bin/geohot-bgwin.sh（**整天停掉 worker**）
#   3) geohot-role-{day,night}.timer        → /opt/geohot/bin/role-window.sh（新，文件却不存在，status=203/EXEC）
# 结果每天 07:00 两台的 worker 直接被停掉一整天：白天不采集、不抽取、更不分析，
# 积压一路堆到 content.analyze 2,163 条。这个脚本把 1) 和 2) 关掉、把 3) 装好，
# 只留「白天采集+抽取+1 个分析槽 / 夜里 2 个分析槽」这一套。
#
# 用法：setup-executor-window.sh [day|night]   （在**执行器**上以 root 运行）
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target=/opt/geohot/bin/role-window.sh
mode="${1:-day}"

install -d -m 755 /opt/geohot/bin
install -m 755 "$here/bin/role-window.sh" "$target"
echo "installed: $target"

# 旧机制：整天停 worker 的那套，以及写 drop-in 的那套。
for u in geohot-bg-day.service geohot-bg-night.service \
         geohot-bg-day.timer geohot-bg-night.timer \
         geohot-exec-window-day.timer geohot-exec-window-night.timer; do
  if systemctl list-unit-files "$u" >/dev/null 2>&1 && systemctl cat "$u" >/dev/null 2>&1; then
    systemctl disable --now "$u" >/dev/null 2>&1 && echo "disabled: $u"
  fi
done

# 新机制：只按时间改 env，worker 由它自己 restart。
for u in geohot-role-day.timer geohot-role-night.timer; do
  if systemctl cat "$u" >/dev/null 2>&1; then
    systemctl enable "$u" >/dev/null 2>&1 && echo "enabled: $u"
  fi
done

# 立刻按当前档位落一次，别等下一个定时点。
env_file=/opt/geohot-exec/.env
if [ ! -f "$env_file" ]; then
  echo "找不到 $env_file（执行器的 env 不在默认位置？）" >&2
  exit 1
fi
"$target" "$mode" "$env_file"
sleep 6
systemctl is-active geohot-exec-worker || true
