#!/bin/bash
# 国内边缘节点安装脚本（幂等）：tunnel 建隧道，edge 建 nginx 缓存反代与保温定时器。
#
#   sudo bash install-edge.sh tunnel    # 数据库 15432 / magpie 3426 / 主库 https 8443
#   sudo bash install-edge.sh edge      # nginx 反向代理 + 50 秒保温
#
# 目标机器：华为云广州 hcss-ecs-6a39（2 vCPU / 1775 MB），用户 geohot 跑执行器，root 装边缘。
set -euo pipefail

PRIMARY_HOST="${GEOHOT_PRIMARY_HOST:-xxc@20.194.28.128}"
IDENTITY="${GEOHOT_PRIMARY_IDENTITY:-/home/geohot/.ssh/id_ed25519}"
EDGE_SERVER_NAME="${GEOHOT_EDGE_SERVER_NAME:-xxc200707.me}"

install_tunnel() {
  cat > /etc/systemd/system/geohot-exec-tunnel.service <<EOF
[Unit]
Description=GeoHot 执行器 SSH 隧道（数据库 15432 / magpie 3426 / 主库 https 8443）
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=geohot
Group=geohot
Environment=HOME=/home/geohot
ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/geohot/.ssh/known_hosts -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -i ${IDENTITY} -L 15432:127.0.0.1:5432 -L 3426:127.0.0.1:3426 -L 8443:127.0.0.1:443 ${PRIMARY_HOST}
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now geohot-exec-tunnel.service
  sleep 5
  systemctl is-active geohot-exec-tunnel.service
  ss -ltn | awk '{print $4}' | grep -E ':(15432|3426|8443)$' | sort -u
}

install_edge() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q nginx >/dev/null

  mkdir -p /var/cache/nginx/geohot-edge
  cat > /etc/nginx/conf.d/geohot-edge-cache.conf <<'EOF'
proxy_cache_path /var/cache/nginx/geohot-edge levels=1:2 keys_zone=geohot_edge:32m max_size=1g inactive=30m use_temp_path=off;
proxy_cache_key "edge-v1:$scheme$host$request_uri";
EOF

  cat > /etc/nginx/sites-available/geohot-domestic.conf <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${EDGE_SERVER_NAME} _;

    access_log /var/log/nginx/geohot-edge.access.log;
    error_log  /var/log/nginx/geohot-edge.error.log warn;

    location = /edge-health {
        default_type text/plain;
        return 200 "edge ok\n";
    }

    location / {
        proxy_pass https://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_name xxc2007.me;
        proxy_ssl_verify off;

        proxy_set_header Host xxc2007.me;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Accept-Encoding "";

        proxy_connect_timeout 8s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;

        proxy_cache geohot_edge;
        proxy_cache_valid 200 301 302 120s;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_cache_lock on;
        proxy_cache_lock_timeout 10s;
        add_header X-Edge-Cache \$upstream_cache_status always;
    }
}
EOF

  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/geohot-domestic.conf /etc/nginx/sites-enabled/geohot-domestic.conf
  nginx -t
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl reload nginx

  cat > /usr/local/bin/geohot-edge-warm.sh <<'EOF'
#!/bin/bash
# 每 50 秒把常用页面走一遍自己的边缘缓存（缓存 120 秒，保温 50 秒 ⇒ 读者永远命中）
set -u
for path in "/geohot/" "/geohot/all?tab=all" "/geohot/hot" "/geohot/daily" "/geohot/topics" "/geohot/feed/all.xml"; do
  code=$(curl -s -o /dev/null -m 25 -w "%{http_code}" -H "Host: xxc200707.me" "http://127.0.0.1${path}")
  [ "$code" = "200" ] || logger -t geohot-edge-warm "warm ${path} -> ${code}"
done
EOF
  chmod 755 /usr/local/bin/geohot-edge-warm.sh

  cat > /etc/systemd/system/geohot-edge-warm.service <<'EOF'
[Unit]
Description=GeoHot 国内边缘缓存保温
After=nginx.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=root
Nice=19
IOSchedulingClass=idle
ExecStart=/usr/local/bin/geohot-edge-warm.sh
EOF

  cat > /etc/systemd/system/geohot-edge-warm.timer <<'EOF'
[Unit]
Description=GeoHot 国内边缘缓存保温（每分钟）

[Timer]
OnBootSec=30s
OnCalendar=*-*-* *:*:00
AccuracySec=5s
Persistent=true
Unit=geohot-edge-warm.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now geohot-edge-warm.timer >/dev/null 2>&1
  /usr/local/bin/geohot-edge-warm.sh
  for i in 1 2 3; do
    curl -s -o /dev/null -m 15 -w "edge /geohot/ %{http_code} %{time_total}s\n" -H "Host: ${EDGE_SERVER_NAME}" http://127.0.0.1/geohot/
  done
}

case "${1:-}" in
  tunnel) install_tunnel ;;
  edge) install_edge ;;
  *) echo "用法：bash install-edge.sh tunnel|edge" >&2; exit 2 ;;
esac
