#!/usr/bin/env bash
# 第三台机器（阿里云 ECS 杭州）的运维侧安装脚本：备份副本、国内探针、真浏览器回归。
#
# 分工与第二台机器（8.148.65.89）的区别：
#   - 第二台内存只有 1 GiB，只做「执行器 + 备份 + curl 探针」；
#   - 这台 2 GiB / 100 Mbps，多担一件：**用真 Chromium 跑读者面回归**（第二台跑不动）。
#
# 用法：bash setup-ops.sh
# 前提：先跑过 setup-exec.sh（geohot 用户、仓库、Node 都就位；隧道服务在跑）。

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PRIMARY="xxc@20.194.28.128"
PRIMARY_KEY="/home/geohot/.ssh/id_ed25519"
APP_DIR="/home/geohot/geohot"
BACKUP_DIR="/var/backups/geohot"
KEEP="${KEEP:-7}"

say() { printf '\n== %s\n' "$*"; }

say "1/4 备份落地（只做副本，主库那份才是第一份）"
install -d -m 750 -o geohot -g geohot "$BACKUP_DIR"
cat > /usr/local/bin/geohot-backup-pull.sh <<'PULL'
#!/usr/bin/env bash
# 从主库现打一份逻辑备份，rsync 回来；只保留最近 KEEP 份。校验大小 > 10MB 才算成功。
set -euo pipefail
PRIMARY="xxc@20.194.28.128"
KEY="/home/geohot/.ssh/id_ed25519"
DIR="/var/backups/geohot"
KEEP="${KEEP:-7}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
remote="/tmp/geohot-$stamp.dump"
ssh -i "$KEY" -o BatchMode=yes "$PRIMARY" "sudo -u postgres pg_dump -Fc -d geohot -f $remote && sudo chmod 644 $remote && ls -l $remote"
rsync -az -e "ssh -i $KEY -o BatchMode=yes" "$PRIMARY:$remote" "$DIR/geohot-$stamp.dump"
ssh -i "$KEY" -o BatchMode=yes "$PRIMARY" "rm -f $remote"
size=$(stat -c %s "$DIR/geohot-$stamp.dump")
[ "$size" -gt 10485760 ] || { echo "backup too small: $size"; exit 1; }
ls -1t "$DIR"/geohot-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok $(du -h "$DIR/geohot-$stamp.dump" | cut -f1) keep=$KEEP"
PULL
chmod 755 /usr/local/bin/geohot-backup-pull.sh

cat > /etc/systemd/system/geohot-backup-pull.service <<UNIT
[Unit]
Description=geohot: pull a logical backup from the primary

[Service]
Type=oneshot
User=geohot
Environment=KEEP=$KEEP
ExecStart=/usr/local/bin/geohot-backup-pull.sh
UNIT
cat > /etc/systemd/system/geohot-backup-pull.timer <<UNIT
[Unit]
Description=geohot: daily backup pull

[Timer]
OnCalendar=*-*-* 03:40:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

say "2/4 国内读者面探针（curl 级，5 分钟一次）"
cat > /usr/local/bin/geohot-probe.sh <<'PROBE'
#!/usr/bin/env bash
# 从国内线路量读者面：命中 Cloudflare 与回源的各自耗时都记下来。
set -uo pipefail
BASE="https://xxc2007.me/geohot"
fail=0
for path in / /all /topics /changelog /feed.xml /api/health; do
  out=$(curl -sS -o /dev/null -w '%{http_code} %{time_total} %{time_connect} %{time_appconnect}' \
    --max-time 30 "$BASE$path" 2>/dev/null) || out="000 0 0 0"
  code=$(echo "$out" | cut -d' ' -f1)
  total=$(echo "$out" | cut -d' ' -f2)
  echo "probe $path $out"
  if [ "$code" != "200" ]; then fail=1; fi
  if awk -v t="$total" 'BEGIN{exit !(t > 5)}'; then fail=1; fi
done
exit "$fail"
PROBE
chmod 755 /usr/local/bin/geohot-probe.sh

cat > /etc/systemd/system/geohot-probe.service <<UNIT
[Unit]
Description=geohot: mainland reader probe

[Service]
Type=oneshot
ExecStart=/usr/local/bin/geohot-probe.sh
UNIT
cat > /etc/systemd/system/geohot-probe.timer <<UNIT
[Unit]
Description=geohot: mainland reader probe timer

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
UNIT

say "3/4 真 Chromium（只用来跑读者面回归，不承担线上流量）"
apt-get install -y -o DPkg::Lock::Timeout=600 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 fonts-noto-cjk
sudo -u geohot bash -lc 'cd '"$APP_DIR"' && npx --yes playwright@1.49.1 install chromium --with-deps' || true
sudo -u geohot bash -lc 'cd '"$APP_DIR"' && ls ~/.cache/ms-playwright 2>/dev/null | head -3'

say "4/4 读者面回归（夜间跑；索引与截图留在本地）"
cat > /usr/local/bin/geohot-reader-regression.sh <<'REG'
#!/usr/bin/env bash
# 用真 Chromium 打开读者面的 11 个路由，判据与主库那套一致：
#   页面真渲染（不是错误页）+ 无 JS 异常 + 无安全策略拦截 + 手机端触底能继续取。
set -uo pipefail
APP="/home/geohot/geohot"
OUT="/var/lib/geohot-regression/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
cd "$APP"
node _diag/browser/verify-r16.mjs --out "$OUT" --base https://xxc2007.me/geohot 2>&1 | tail -40
# 只留最近 7 轮
ls -1dt /var/lib/geohot-regression/*/ 2>/dev/null | tail -n +8 | xargs -r rm -rf
REG
chmod 755 /usr/local/bin/geohot-reader-regression.sh

cat > /etc/systemd/system/geohot-reader-regression.service <<UNIT
[Unit]
Description=geohot: reader regression with a real browser

[Service]
Type=oneshot
User=geohot
ExecStart=/usr/local/bin/geohot-reader-regression.sh
Nice=10
UNIT
cat > /etc/systemd/system/geohot-reader-regression.timer <<UNIT
[Unit]
Description=geohot: nightly reader regression

[Timer]
OnCalendar=*-*-* 04:20:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now geohot-backup-pull.timer geohot-probe.timer geohot-reader-regression.timer
echo "OPS_TIMERS:"
systemctl list-timers --no-pager 'geohot-*' 2>/dev/null | sed -n 1,8p
echo "SETUP_OPS_OK"
