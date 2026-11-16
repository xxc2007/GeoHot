#!/usr/bin/env bash
# 新服务器第二个脚本：把 exec 节点变成「24h 分析执行器」。
# - geohot-exec-db-tunnel.service：SSH 隧道到主库（15432→主库 5432）
# - geohot-exec-model-tunnel.service：SSH 隧道到杭州 Magpie（3426→杭州 3426）
# - geohot-exec-worker.service：WORKER_ROLE=all，1 条分析并发，内存上限 520M
# 2026-11-16 全服务器自治：Magpie 已从 Azure 迁移到杭州（47.97.97.62），
# exec 节点模型端口走杭州，DB 仍走 Azure。WorkBuddy 桥（3065/3066）暂未迁移。
# 前置：/opt/geohot-exec/.env 已由 lead scp 上来（600，含 provider key 与改写过的 DATABASE_URL）。
set -euo pipefail
test -s /opt/geohot-exec/.env || { echo "!! /opt/geohot-exec/.env 不存在"; exit 1; }
chown root:geohot /opt/geohot-exec/.env
chmod 640 /opt/geohot-exec/.env

# 2026-11-16：武汉节点补心跳唯一键。三台 exec 都跑 WORKER_ROLE=all，
# 不设 GEOHOT_HEARTBEAT_KEY 时全部写 heartbeat.worker，互相覆盖，后台面板只看得见最后心跳的那台。
HOST_TAG=$(hostname -s)
grep -q '^GEOHOT_HEARTBEAT_KEY=' /opt/geohot-exec/.env || echo "GEOHOT_HEARTBEAT_KEY=heartbeat.content-executor@${HOST_TAG}" >> /opt/geohot-exec/.env
grep -q '^GEOHOT_HEARTBEAT_LABEL=' /opt/geohot-exec/.env || echo "GEOHOT_HEARTBEAT_LABEL=${HEARTBEAT_LABEL:-武汉·8.148.65.89}" >> /opt/geohot-exec/.env

# DB tunnel → Azure 主库
cat > /etc/systemd/system/geohot-exec-db-tunnel.service <<'UNIT'
[Unit]
Description=GeoHot executor DB tunnel to primary (postgres 15432->5432)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=geohot
ExecStart=/usr/bin/ssh -N -T \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  -i /home/geohot/.ssh/id_ed25519 \
  -L 127.0.0.1:15432:127.0.0.1:5432 \
  xxc@20.194.28.128
Restart=always
RestartSec=10
MemoryMax=32M

[Install]
WantedBy=multi-user.target
UNIT

# Model tunnel → 杭州 Magpie
cat > /etc/systemd/system/geohot-exec-model-tunnel.service <<'UNIT'
[Unit]
Description=GeoHot executor model tunnel to Hangzhou Magpie (3426->3426)
After=network-online.target geohot-exec-db-tunnel.service
Wants=network-online.target

[Service]
Type=simple
User=geohot
ExecStart=/usr/bin/ssh -N -T \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  -i /home/geohot/.ssh/id_ed25519 \
  -L 127.0.0.1:3426:127.0.0.1:3426 \
  geohot@47.97.97.62
Restart=always
RestartSec=10
MemoryMax=32M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/geohot-exec-worker.service <<'UNIT'
[Unit]
Description=GeoHot content executor (analysis only, 1 slot)
After=network-online.target geohot-exec-tunnel.service
Wants=geohot-exec-tunnel.service

[Service]
Type=simple
User=geohot
WorkingDirectory=/home/geohot/geohot
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/usr/local/node/bin/node --env-file=/opt/geohot-exec/.env apps/worker/src/main.ts
Restart=always
RestartSec=15
MemoryHigh=430M
MemoryMax=520M
MemorySwapMax=1024M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now geohot-exec-tunnel.service
sleep 8
systemctl enable --now geohot-exec-worker.service
sleep 20
echo "== tunnel =="; systemctl is-active geohot-exec-tunnel.service; ss -ltnp | grep -E '15432|3426' || true
echo "== worker ==";  systemctl is-active geohot-exec-worker.service
journalctl -u geohot-exec-worker.service -n 25 --no-pager | tail -25
echo "== memory =="; systemctl show geohot-exec-worker.service -p MemoryCurrent -p MemoryMax
free -m | sed -n 1,3p
echo EXEC_SETUP_OK
