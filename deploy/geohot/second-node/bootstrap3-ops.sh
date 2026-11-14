#!/usr/bin/env bash
# 新服务器第三批：备份落地 + 读者面探针。
# 备份：在新箱上发起，主库 pg_dump -Fc 写到主库 /tmp，再 rsync 回来 —— 这样 pg_dump 版本永远与主库一致（主库是 PG17，Ubuntu 24.04 自带的客户端是 16）。
# 探针：每 5 分钟打一次读者面与 /api/health，失败写 journal（systemd 会保留），供事后追溯。
set -euo pipefail
PRIMARY_KEY=/home/geohot/.ssh/id_ed25519
PRIMARY=xxc@20.194.28.128
DEST=/var/backups/geohot
KEEP=5

install -d -m 750 -o root -g root "$DEST"

cat > /usr/local/bin/geohot-backup.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
PRIMARY_KEY=/home/geohot/.ssh/id_ed25519
PRIMARY=xxc@20.194.28.128
DEST=/var/backups/geohot
KEEP=5
SSH="ssh -i $PRIMARY_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
echo "backup start $STAMP"
# 主库导出（custom 格式自带压缩），落在主库 /tmp 再拉回来，避免版本错配。
# 2026-11-15 03:2x：一次全量 pg_dump 把主库那块 250 IOPS 的盘读到 io some avg10=99 二十多分钟，
# 读者首页 3.5 秒、还有 503 —— 备份和读者抢盘，而 receipts / receipt_attempts 两张日志表占了库里一半
# 体积（2.8 GB + 0.6 GB），恢复它们没有价值。于是：① ionice idle + nice 19，让备份永远排在读者后面；
# ② 只导这两张表的结构、不导数据（--exclude-table-data），dump 体积与读盘量直接砍半。
$SSH "$PRIMARY" "sudo -u postgres ionice -c 3 nice -n 19 pg_dump -Fc -d geohot --exclude-table-data=public.receipts --exclude-table-data=public.receipt_attempts -f /tmp/geohot-$STAMP.dump && sudo chmod 644 /tmp/geohot-$STAMP.dump && ls -l /tmp/geohot-$STAMP.dump | awk '{print \$5}'"
SIZE=$($SSH "$PRIMARY" "stat -c %s /tmp/geohot-$STAMP.dump")
if [ "${SIZE:-0}" -lt 10000000 ]; then echo "!! dump too small ($SIZE bytes), abort"; $SSH "$PRIMARY" "sudo rm -f /tmp/geohot-$STAMP.dump"; exit 1; fi
rsync -e "ssh -i $PRIMARY_KEY -o BatchMode=yes" "$PRIMARY:/tmp/geohot-$STAMP.dump" "$DEST/" 2>/dev/null \
  || $SSH "$PRIMARY" "sudo cat /tmp/geohot-$STAMP.dump" > "$DEST/geohot-$STAMP.dump"
$SSH "$PRIMARY" "sudo rm -f /tmp/geohot-$STAMP.dump"
chmod 600 "$DEST/geohot-$STAMP.dump"
ls -l "$DEST/geohot-$STAMP.dump"
# 只留最近 KEEP 份
ls -1t "$DEST"/geohot-*.dump | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "backup done: $(du -sh $DEST | cut -f1) in $DEST, files=$(ls -1 $DEST/geohot-*.dump | wc -l)"
SH
chmod 750 /usr/local/bin/geohot-backup.sh

cat > /usr/local/bin/geohot-probe.sh <<'SH'
#!/usr/bin/env bash
# 读者面探针：首页 / 全部 / api health 三处，各 10 秒预算，失败重试一次。
set -uo pipefail
fail=0
probe() {
  local url="$1" want="$2" out code ms
  out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "$url" || echo "000 0")
  code=${out% *}; ms=${out#* }
  if [ "$code" != "$want" ]; then
    out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "$url" || echo "000 0")
    code=${out% *}; ms=${out#* }
  fi
  if [ "$code" != "$want" ]; then fail=1; echo "FAIL $url -> $code after ${ms}s"; else echo "ok $url $code ${ms}s"; fi
}
probe https://xxc2007.me/geohot/ 200
probe https://xxc2007.me/geohot/all 200
probe https://xxc2007.me/geohot/api/health 200
exit $fail
SH
chmod 750 /usr/local/bin/geohot-probe.sh

cat > /etc/systemd/system/geohot-backup.service <<'UNIT'
[Unit]
Description=GeoHot database backup from primary (pg_dump -Fc, keep 5)
After=network-online.target geohot-exec-tunnel.service

[Service]
Type=oneshot
User=geohot
ExecStart=/usr/local/bin/geohot-backup.sh
# 备份是「可以慢、但不许抢读者」的活：idle 类 + nice 19，慢盘上它会一直给前台让路。
Nice=19
IOSchedulingClass=idle
IOSchedulingPriority=7
UNIT

cat > /etc/systemd/system/geohot-backup.timer <<'UNIT'
[Unit]
Description=Daily GeoHot backup at 03:20 (Asia/Shanghai local)

[Timer]
OnCalendar=*-*-* 03:20:00
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/geohot-probe.service <<'UNIT'
[Unit]
Description=GeoHot reader-face probe
After=network-online.target

[Service]
Type=oneshot
User=geohot
ExecStart=/usr/local/bin/geohot-probe.sh
UNIT

cat > /etc/systemd/system/geohot-probe.timer <<'UNIT'
[Unit]
Description=Probe reader face every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now geohot-probe.timer
systemctl enable --now geohot-backup.timer
systemctl start geohot-probe.service || true
echo "== probe =="; journalctl -u geohot-probe.service -n 6 --no-pager | tail -5
echo "== timers =="; systemctl list-timers 'geohot-*' --no-pager | head -5
echo "== backup dry-run (this one takes a while) =="
systemctl start geohot-backup.service || echo "!! backup failed, see journalctl -u geohot-backup"
journalctl -u geohot-backup.service -n 8 --no-pager | tail -6
echo BOOTSTRAP3_OK
