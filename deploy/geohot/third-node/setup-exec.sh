#!/usr/bin/env bash
# 第三台机器（阿里云 ECS 杭州，2 vCPU / 2 GiB / 40 GiB，Ubuntu 22.04）的一体化安装脚本。
#
# 它做的事，按顺序：
#   1. 系统依赖 + 2 GiB swap（2 GiB 内存跑 worker 时仍要留余量给页缓存）
#   2. Node 24（仓库 package.json 要求 >=24.11），走 npmmirror 二进制源
#   3. 建 geohot 用户，装部署公钥（本机 ~/.ssh/geohot_deploy_ed25519.pub）
#   4. clone 仓库 + npm ci（registry 指 npmmirror）
#   5. 生成 /opt/geohot-exec/.env（从主库的真实 .env 拷贝后只改连接与角色）
#   6. geohot-exec-tunnel.service + geohot-exec-worker.service
#   7. 白天/夜间两档并发的 timer（07:00 / 01:00）
#
# 用法（在新机器上以 root 跑）：
#   bash setup-exec.sh
#
# 前提：这台机器的 ~/.ssh/id_ed25519.pub 已经被加进主库 xxc@20.194.28.128 的 authorized_keys。
# 数据只走 SSH 隧道：不开公网 5432，也不把数据库口令暴露在任何监听端口上。

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PRIMARY="xxc@20.194.28.128"
PRIMARY_KEY="/home/geohot/.ssh/id_ed25519"
APP_DIR="/home/geohot/geohot"
EXEC_DIR="/opt/geohot-exec"
DEPLOY_PUB="${DEPLOY_PUB:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4G5jMeTdomI/wgz/vhnt3jTGHUlHSOMZKSoVFV9n8Y geohot-deploy@xxc2007}"

say() { printf '\n== %s\n' "$*"; }

say "1/7 系统依赖与 swap"
apt-get update -o DPkg::Lock::Timeout=600
apt-get install -y -o DPkg::Lock::Timeout=600 \
  git curl ca-certificates xz-utils rsync jq unzip procps cron openssh-client
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "2/7 Node 24"
if ! /usr/local/node/bin/node -v >/dev/null 2>&1; then
  mkdir -p /usr/local/node
  base="https://cdn.npmmirror.com/binaries/node/latest-v24.x"
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $2; exit}')
  curl -fsSL "$base/$file" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1
  rm -f /tmp/node.tar.xz
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/node/bin/npx /usr/local/bin/npx
fi
/usr/local/node/bin/node -v

say "3/7 用户与公钥"
id -u geohot >/dev/null 2>&1 || useradd -m -s /bin/bash geohot
install -d -m 700 -o geohot -g geohot /home/geohot/.ssh
touch /home/geohot/.ssh/authorized_keys
grep -qF "$DEPLOY_PUB" /home/geohot/.ssh/authorized_keys || echo "$DEPLOY_PUB" >> /home/geohot/.ssh/authorized_keys
chmod 600 /home/geohot/.ssh/authorized_keys
chown -R geohot:geohot /home/geohot/.ssh
install -d -m 700 /root/.ssh
grep -qF "$DEPLOY_PUB" /root/.ssh/authorized_keys 2>/dev/null || echo "$DEPLOY_PUB" >> /root/.ssh/authorized_keys

say "4/7 仓库与依赖"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u geohot git clone --depth 1 https://github.com/xxc2007/GeoHot.git "$APP_DIR" \
    || sudo -u geohot git clone --depth 1 https://ghfast.top/https://github.com/xxc2007/GeoHot.git "$APP_DIR"
fi
sudo -u geohot git -C "$APP_DIR" rev-parse --short HEAD
sudo -u geohot bash -lc 'cd '"$APP_DIR"' && npm config set registry https://registry.npmmirror.com && npm ci --no-audit --no-fund'

say "5/7 执行器环境文件"
install -d -m 750 -o geohot -g geohot "$EXEC_DIR"
if [ ! -f "$EXEC_DIR/.env" ]; then
  # 从主库取真实配置（provider 密钥、SITE_URL 等），随后只覆盖与「这台机器」有关的部分。
  ssh -i "$PRIMARY_KEY" -o BatchMode=yes "$PRIMARY" 'sudo cat /opt/geohot/app/.env' > "$EXEC_DIR/.env"
  sed -i 's#\(DATABASE_URL=postgres://[^@]*@127\.0\.0\.1:\)5432#\115432#' "$EXEC_DIR/.env"
  {
    echo 'WORKER_ROLE=content-executor'
    echo 'COLLECT_ENABLED=true'
    echo 'MODEL_CALLS_ENABLED=true'
    echo 'JINA_BODY_FALLBACK=false'
    echo 'NODE_ENV=production'
    echo 'GEOHOT_INTAKE_LANES=combined'
    echo 'GEOHOT_INTAKE_COMBINED_LIMIT=3'
    echo 'GEOHOT_INTAKE_LANE_LIMIT=3'
    echo 'GEOHOT_INTAKE_ANALYSIS_SLOTS=3'
    echo 'ANALYZE_CONCURRENCY=3'
    echo 'EXTRACT_CONCURRENCY=1'
    echo 'DATABASE_POOL_MAX=8'
    echo 'HEALTH_READ_STATEMENT_TIMEOUT_MS=15000'
  } >> "$EXEC_DIR/.env"
  chmod 600 "$EXEC_DIR/.env"
  chown geohot:geohot "$EXEC_DIR/.env"
fi

say "6/7 systemd 单元"
cat > /etc/systemd/system/geohot-exec-tunnel.service <<UNIT
[Unit]
Description=geohot: SSH tunnel to the primary database and magpie
After=network-online.target
Wants=network-online.target

[Service]
User=geohot
ExecStart=/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \\
  -i $PRIMARY_KEY -L 127.0.0.1:15432:127.0.0.1:5432 -L 127.0.0.1:3426:127.0.0.1:3426 $PRIMARY
Restart=always
RestartSec=10
MemoryMax=64M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/geohot-exec-worker.service <<UNIT
[Unit]
Description=geohot content executor (analysis on this node)
After=geohot-exec-tunnel.service
Requires=geohot-exec-tunnel.service

[Service]
User=geohot
WorkingDirectory=$APP_DIR
EnvironmentFile=$EXEC_DIR/.env
ExecStart=/usr/local/node/bin/node --env-file=$EXEC_DIR/.env apps/worker/src/main.ts
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=600
MemoryHigh=900M
MemoryMax=1100M
MemorySwapMax=1024M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now geohot-exec-tunnel.service geohot-exec-worker.service
sleep 8
systemctl is-active geohot-exec-tunnel.service geohot-exec-worker.service

say "7/7 两档并发 timer"
cat > /usr/local/bin/geohot-exec-window.sh <<'WIN'
#!/usr/bin/env bash
# 白天留 2 个分析槽（读者面优先），夜里 3 个（这台 2 GiB 撑得住，且夜间读者少）。
set -euo pipefail
mode="${1:-day}"
case "$mode" in
  day)   slots=2; conc=2 ;;
  night) slots=3; conc=3 ;;
  *) echo "usage: $0 day|night" >&2; exit 2 ;;
esac
install -d -m 755 /etc/systemd/system/geohot-exec-worker.service.d
cat > /etc/systemd/system/geohot-exec-worker.service.d/50-window.conf <<CONF
[Service]
Environment=GEOHOT_INTAKE_ANALYSIS_SLOTS=$slots
Environment=ANALYZE_CONCURRENCY=$conc
CONF
systemctl daemon-reload
systemctl restart geohot-exec-worker.service
echo "window=$mode slots=$slots concurrency=$conc"
WIN
chmod 755 /usr/local/bin/geohot-exec-window.sh

for pair in "day 07:00" "night 01:00"; do
  set -- $pair
  cat > /etc/systemd/system/geohot-exec-window-$1.service <<UNIT
[Unit]
Description=geohot exec window: $1

[Service]
Type=oneshot
ExecStart=/usr/local/bin/geohot-exec-window.sh $1
UNIT
  cat > /etc/systemd/system/geohot-exec-window-$1.timer <<UNIT
[Unit]
Description=geohot exec window timer: $1

[Timer]
OnCalendar=*-*-* $2:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
done
systemctl daemon-reload
systemctl enable --now geohot-exec-window-day.timer geohot-exec-window-night.timer

say "完成"
systemctl --no-pager --lines=0 status geohot-exec-worker.service | sed -n 1,6p
echo "SETUP_EXEC_OK"
