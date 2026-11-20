#!/bin/bash
# install-exec-tunnels.sh — 拆分 systemd 隧道单元到 exec 节点
# 用法: 在 exec 节点上以 root 运行: bash install-exec-tunnels.sh [db-target] [model-target]
# SSH 目标不写死在仓库里：优先取位置参数，缺省回落环境变量；两者都缺则明确报错退出，
# 不静默连到默认地址。
#   db-target:    主库 SSH 目标（user@<主库主机>），环境变量 GEOHOT_PRIMARY_HOST
#   model-target: Magpie SSH 目标（user@<杭州主机>），环境变量 GEOHOT_HANGZHOU_HOST
# 产出:
#   /etc/systemd/system/geohot-exec-db-tunnel.service    (15432 -> 主库:5432)
#   /etc/systemd/system/geohot-exec-model-tunnel.service (3426 -> Magpie:3426)
# 端口仅绑定 127.0.0.1, 不公网暴露。

set -euo pipefail

DB_TARGET="${1:-${GEOHOT_PRIMARY_HOST:-}}"
MODEL_TARGET="${2:-${GEOHOT_HANGZHOU_HOST:-}}"
: "${DB_TARGET:?需要主库 SSH 目标：传位置参数 1，或设置 GEOHOT_PRIMARY_HOST（user@<主库主机>）}"
: "${MODEL_TARGET:?需要 Magpie SSH 目标：传位置参数 2，或设置 GEOHOT_HANGZHOU_HOST（user@<杭州主机>）}"
GEOSSH_KEY="${GEOHOT_PRIMARY_IDENTITY:-/home/geohot/.ssh/id_ed25519}"

cat > /etc/systemd/system/geohot-exec-db-tunnel.service <<UNIT
[Unit]
Description=GEOHOT exec DB tunnel ($(hostname):15432 -> primary:5432)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=geohot
ExecStart=/usr/bin/ssh -N -T \\
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \\
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \\
  -i ${GEOSSH_KEY} \\
  -L 127.0.0.1:15432:127.0.0.1:5432 \\
  ${DB_TARGET}
Restart=always
RestartSec=10
MemoryMax=32M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/geohot-exec-model-tunnel.service <<UNIT
[Unit]
Description=GEOHOT exec model tunnel ($(hostname):3426 -> Magpie:3426)
After=network-online.target geohot-exec-db-tunnel.service
Wants=network-online.target

[Service]
Type=simple
User=geohot
ExecStart=/usr/bin/ssh -N -T \\
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \\
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \\
  -i ${GEOSSH_KEY} \\
  -L 127.0.0.1:3426:127.0.0.1:3426 \\
  ${MODEL_TARGET}
Restart=always
RestartSec=10
MemoryMax=32M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now geohot-exec-db-tunnel.service geohot-exec-model-tunnel.service

echo "=== 状态 ==="
systemctl is-active geohot-exec-db-tunnel.service geohot-exec-model-tunnel.service
echo "=== 端口 (应仅 127.0.0.1) ==="
ss -tlnp | grep -E '15432|3426'
echo "=== 公网暴露检查 ==="
ss -tlnp | grep -E '15432|3426' | grep -v '127.0.0.1' && echo "警告: 公网绑定!" || echo "OK: 仅 localhost"
