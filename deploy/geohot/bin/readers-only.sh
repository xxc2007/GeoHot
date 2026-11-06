#!/usr/bin/env bash
# readers-only.sh — 把这台机器定成「只做读者面」或解除。
#
# 为什么需要它：891MB / 2 vCPU 的那台机器实测跑不了 worker。任何角色（all 或 coordinator）
# 一起，60 秒内 load 就到 19–23、首页 /geohot/ 从 0.05 秒掉到 20 秒超时（2026-11-06 19:1x
# 逐分钟采样）。停掉立刻回到 0.03–0.14 秒。所以「本机只做读者面、抓取与分析交给常驻执行器」
# 是一个真实的、长期的形态，不是一个临时绕道。
#
# 形态必须落在磁盘上，不能靠人记住：
#   /etc/geohot/readers-only   存在 ⇒ verify-deploy.sh 允许 worker inactive，但要求它 disabled；
#                              deploy.sh 重启单元时跳过 geohot-worker（否则每次部署都把读者面打一次）。
#
# 用法（root）：
#   bash readers-only.sh on      # 建标记、停 worker、disable（重启也不会自己起来）
#   bash readers-only.sh off     # 删标记、enable、起 worker
#   bash readers-only.sh status  # 只看当前形态
set -uo pipefail
MARKER=/etc/geohot/readers-only
say() { printf '%s\n' "$*"; }

status() {
  local mark="无" state enabled
  [[ -f "$MARKER" ]] && mark="有（$(head -1 "$MARKER" 2>/dev/null || echo '空文件')）"
  state="$(systemctl is-active geohot-worker 2>/dev/null || true)"
  enabled="$(systemctl is-enabled geohot-worker 2>/dev/null || true)"
  say "readers-only 标记: $mark"
  say "geohot-worker: $state / $enabled"
}

case "${1:-status}" in
  on)
    install -d -m 755 /etc/geohot
    printf '%s\n' "这台机器只做读者面（api + web）。worker 停了是设计，不是故障。" \
                  "置位时间: $(date -Is)" > "$MARKER"
    chmod 644 "$MARKER"
    systemctl stop geohot-worker 2>/dev/null || true
    systemctl disable geohot-worker 2>/dev/null || true
    # stop 有时会在 90 秒 TimeoutStopSec 上挂住并留下 failed；reset 一下，别让面板显示红点。
    systemctl reset-failed geohot-worker 2>/dev/null || true
    say "已置位：worker 停了并 disable。抓取与分析由此刻在岗的执行器承担（面板「协同节点」可见）。"
    status
    ;;
  off)
    rm -f "$MARKER"
    systemctl enable geohot-worker 2>/dev/null || true
    systemctl start geohot-worker 2>/dev/null || true
    say "已解除：worker 恢复 enable + start。"
    status
    ;;
  status) status ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) say "未知参数：$1（可用 on / off / status）" >&2; exit 2 ;;
esac
