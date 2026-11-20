#!/bin/bash
# 国内边缘节点安装脚本（幂等）：tunnel 建隧道，edge 建 nginx 缓存反代与保温定时器。
#
#   sudo bash install-edge.sh tunnel    # 数据库 15432 / magpie 3426 / 主库 https 8443
#   sudo bash install-edge.sh edge      # nginx 反向代理 + 50 秒保温
#
# 目标机器：国内边缘节点（2 vCPU / 1775 MB），用户 geohot 跑执行器，root 装边缘。
set -euo pipefail

# 主库 SSH 目标不写死在仓库里：必须由环境变量给出（user@<主库主机>），缺值明确报错退出，
# 不静默连到默认地址。示例格式见交付说明（文档保留段地址，非生产主机）。
PRIMARY_HOST="${GEOHOT_PRIMARY_HOST:-}"
: "${PRIMARY_HOST:?需要 GEOHOT_PRIMARY_HOST（主库 SSH 目标 user@<主库主机>）}"
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

  # 保温脚本要知道用哪个域名（装过 TLS 就是 cn 子域，没装就是 IP + Host 头）。
  # 走环境文件而不是写死，`tls` 子命令重装后不用再改脚本。
  cat > /etc/geohot-edge.env <<EOF
EDGE_SERVER_NAME=${EDGE_SERVER_NAME}
EDGE_SCHEME=http
EOF
  chmod 644 /etc/geohot-edge.env

  cat > /usr/local/bin/geohot-edge-warm.sh <<'EOF'
#!/bin/bash
# 每 50 秒把常用页面走一遍自己的边缘缓存（缓存 120 秒，保温 50 秒 ⇒ 读者永远命中）
set -u
[ -r /etc/geohot-edge.env ] && . /etc/geohot-edge.env
HOST="${EDGE_SERVER_NAME:-xxc200707.me}"
SCHEME="${EDGE_SCHEME:-http}"
for path in "/geohot/" "/geohot/all?tab=all" "/geohot/hot" "/geohot/daily" "/geohot/topics" "/geohot/feed/all.xml"; do
  if [ "$SCHEME" = https ]; then
    code=$(curl -sk -o /dev/null -m 25 --resolve "${HOST}:443:127.0.0.1" -w "%{http_code}" "https://${HOST}${path}")
  else
    code=$(curl -s -o /dev/null -m 25 -H "Host: ${HOST}" -w "%{http_code}" "http://127.0.0.1${path}")
  fi
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

install_tls() {
  : "${CLOUDFLARE_API_TOKEN:?需要环境变量 CLOUDFLARE_API_TOKEN（Zone.DNS:Edit，只授权这一条区域）}"
  local domain="${GEOHOT_EDGE_TLS_NAME:-cn.xxc2007.me}"
  local email="${GEOHOT_EDGE_EMAIL:-}"
  : "${email:?需要 GEOHOT_EDGE_EMAIL（certbot 注册邮箱，不写默认值）}"

  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-dns-cloudflare >/dev/null
  printf 'dns_cloudflare_api_token = %s\n' "$CLOUDFLARE_API_TOKEN" > /etc/letsencrypt/cloudflare.ini
  chmod 600 /etc/letsencrypt/cloudflare.ini

  # DNS-01：华为云对未备案注册域的 80/443 一律拦（实测 403 ADM/2.1.1 与 443 超时），
  # HTTP-01 从境外校验节点过来必然失败，所以证书只能走 DNS。
  certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --cert-name "$domain" -d "$domain" --non-interactive --agree-tos -m "$email" --keep-until-expiring

  sed -e "s|__DOMAIN__|$domain|g" > /etc/nginx/sites-available/geohot-edge-tls.conf <<'EOF'
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=31536000" always;

    access_log /var/log/nginx/geohot-edge.access.log;
    error_log  /var/log/nginx/geohot-edge.error.log warn;

    location = /edge-health { default_type text/plain; return 200 "edge ok\n"; }
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; default_type text/plain; }
    location / {
        proxy_pass https://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_name xxc2007.me;
        proxy_ssl_verify off;
        proxy_set_header Host xxc2007.me;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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
        add_header X-Edge-Cache $upstream_cache_status always;
    }
}
EOF

  sed -e "s|__DOMAIN__|$domain|g" > /etc/nginx/sites-available/geohot-edge-http.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; default_type text/plain; }
    location = /edge-health { default_type text/plain; return 200 "edge ok\n"; }
    location / { return 301 https://$host$request_uri; }
}
EOF

  ln -sf /etc/nginx/sites-available/geohot-edge-tls.conf /etc/nginx/sites-enabled/geohot-edge-tls.conf
  ln -sf /etc/nginx/sites-available/geohot-edge-http.conf /etc/nginx/sites-enabled/geohot-edge-http.conf
  nginx -t
  systemctl reload nginx

  # 保温器改成走 https，并把域名记进环境文件
  cat > /etc/geohot-edge.env <<EOF
EDGE_SERVER_NAME=${domain}
EDGE_SCHEME=https
EOF
  chmod 644 /etc/geohot-edge.env
  /usr/local/bin/geohot-edge-warm.sh || true

  # 续期交给 cloudflare 插件（dry-run 直接验证真实链路）
  certbot renew --cert-name "$domain" --dry-run 2>&1 | tail -3
  for i in 1 2 3; do
    curl -s -o /dev/null -m 20 -w "tls /geohot/ %{http_code} %{time_total}s\n" "https://${domain}/geohot/"
  done
}

case "${1:-}" in
  tunnel) install_tunnel ;;
  edge) install_edge ;;
  tls) install_tls ;;
  *) echo "用法：bash install-edge.sh tunnel|edge|tls" >&2; exit 2 ;;
esac
