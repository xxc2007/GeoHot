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
# 2026-11-06 的两次翻车都在这两行上：
# ① ssh 失败时 `> .env` 已经建出 0 字节文件，`[ ! -f ]` 于是永远为假 —— 脚本「成功」，worker 却读不到
#    DATABASE_URL，回落 127.0.0.1:5432 无限重启（杭州 iZbp14vh9… 的第一天就是这样）；
# ② 文件必须 geohot 可读（单元 User=geohot），写成 root:root 600 时 node 报 `.env: not found` 后同样无限重启。
# 因此：先写临时文件、确认非空再落位；落到 600 之后用 `sudo -u geohot test -r` 亲自验一次可读性。
if [ ! -s "$EXEC_DIR/.env" ]; then
  # 从主库取真实配置（provider 密钥、SITE_URL 等），随后只覆盖与「这台机器」有关的部分。
  tmp_env="$(mktemp)"
  if ! ssh -i "$PRIMARY_KEY" -o BatchMode=yes "$PRIMARY" 'sudo cat /opt/geohot/app/.env' > "$tmp_env" || [ ! -s "$tmp_env" ]; then
    rm -f "$tmp_env"
    echo "!! 取不到主库 .env（隧道/密钥/权限）；不写空文件，直接退出 —— 修好 ssh 再重跑本脚本" >&2
    exit 1
  fi
  sed -i 's#\(DATABASE_URL=postgres://[^@]*@127\.0\.0\.1:\)5432#\115432#' "$tmp_env"
  {
    # 2026-11-06：这台机器是**唯一常驻的调度者**。主库只做读者面（891MB 跑 worker 会把首页拖到 000），
    # 武汉是 content-executor，所以 cron（sources.schedule / content.sweep / topics.assign / hot.rank …）
    # 只有 WORKER_ROLE=all 才带 coordinator:true 才有人跑；写成 content-executor 会让整条定时链静默停摆
    # （2026-11-06 19:4x 实测：改回 all 后六个 cron 队列立即重新出现）。
    echo 'WORKER_ROLE=all'
    echo 'COLLECT_ENABLED=true'
    echo 'MODEL_CALLS_ENABLED=true'
    echo 'JINA_BODY_FALLBACK=false'
    echo 'NODE_ENV=production'
    echo 'GEOHOT_INTAKE_LANES=combined'
    # 车道上限跟「最忙的那一档」对齐（夜档 4 槽）；当天实际领几条由 window 单元用
    # Environment=GEOHOT_INTAKE_ANALYSIS_SLOTS / ANALYZE_CONCURRENCY 覆盖（systemd 的 Environment 盖过 EnvironmentFile），
    # 所以这两个数不写在这里 —— 写死会造成「.env 说 4、单元说 2」的两份真相（2026-11-06 踩过）。
    echo 'GEOHOT_INTAKE_COMBINED_LIMIT=4'
    echo 'GEOHOT_INTAKE_LANE_LIMIT=4'
    echo 'EXTRACT_CONCURRENCY=1'
    echo 'DATABASE_POOL_MAX=8'
    echo 'HEALTH_READ_STATEMENT_TIMEOUT_MS=15000'
  } >> "$tmp_env"
  # 落位：先 root 600 保住密钥，再 chown 给运行用户 —— install 出来的 root:root 600 是那天无限重启的真因。
  install -m 600 -o geohot -g geohot "$tmp_env" "$EXEC_DIR/.env"
  rm -f "$tmp_env"
  if ! sudo -u geohot test -r "$EXEC_DIR/.env"; then
    echo "!! $EXEC_DIR/.env 对 geohot 不可读（单元 User=geohot 会报 '.env: not found' 并无限重启）" >&2
    exit 1
  fi
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
  day)   slots=12; conc=12; lanes=12 ;;
  night) slots=12; conc=12; lanes=12 ;;
  *) echo "usage: $0 day|night" >&2; exit 2 ;;
esac
install -d -m 755 /etc/systemd/system/geohot-exec-worker.service.d
cat > /etc/systemd/system/geohot-exec-worker.service.d/50-window.conf <<CONF
[Service]
Environment=GEOHOT_INTAKE_LANES=combined
Environment=GEOHOT_INTAKE_ANALYSIS_SLOTS=$slots
Environment=GEOHOT_INTAKE_LANE_LIMIT=$lanes
Environment=GEOHOT_INTAKE_COMBINED_LIMIT=$lanes
Environment=ANALYZE_CONCURRENCY=$conc
Environment=GEOHOT_RESOURCE_PROFILE=balanced
Environment=GEOHOT_PRESSURE_LOAD_PER_CPU=6
Environment=GEOHOT_PRESSURE_MEMORY_FULL=60
Environment=GEOHOT_PRESSURE_IO_FULL=80
Environment=GEOHOT_PRESSURE_CPU_SOME=95
Environment=GEOHOT_PRESSURE_AVAILABLE_MIB=48
# 翻译指定的门：2026-11-07 的 .env 里钉着 12 个已死的模型键，译文永远不 complete，
# 读者面就停在凌晨那几条。这里是唯一健康的那扇门；换门只改这一行。
Environment=TRANSLATE_MODEL=dots3-note-prev
TimeoutStopSec=600
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
