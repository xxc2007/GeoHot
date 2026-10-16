#!/bin/bash
# GEOHOT 读者面守护：判定并发（ANALYZE_CONCURRENCY）高于 4 时，一旦读者面或内存出现退化，就把它降回 4 并停机自锁。
# 装法（这台机器已装，模板与线上逐字节一致）：
#   sudo install -m 755 deploy/geohot/conc-guard.sh /opt/geohot/bin/conc-guard.sh
#   sudo cp deploy/geohot/systemd/geohot-conc-guard.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now geohot-conc-guard.timer
# 判据（2026-10-16 实测出来的三条线，不是猜的）：四个读者面里 >5 s 的样本数 ≥3、或 MemAvailable <40 MB、
# 或已用 swap >1400 MB、或 6 分钟窗口内 ≥2 条 5xx。当天现值：慢样本 0/18、MemAvailable 76–227 MB、
# swap 671–920 MB、5xx 0 —— 都不会误触发。触发过就必须人工复位：
#   sudo rm /etc/geohot/conc-guard.tripped && sudo sed -i 's/^ANALYZE_CONCURRENCY=.*/ANALYZE_CONCURRENCY=6/' /opt/geohot/app/.env
#   sudo systemctl restart geohot-worker
# 证活方式（新判据都要先在"必然触发"的样本上跑一遍）：sudo touch /etc/geohot/conc-guard.force && sudo bash /opt/geohot/bin/conc-guard.sh
# —— 实测它把 8 降到 4、重启了 worker、写了 env-guard-trip-* 备份并自锁；测完删掉 force 与 tripped 两个标记。
# 这个单元刻意**不加沙箱**（NoNewPrivileges 会让 sudo 失效，ProtectSystem=strict 会挡住改写 .env）：
# 它唯一的职责就是改一个环境变量再重启 geohot-worker，写动作只有两处、都在本文件里。沙箱化归工单 #200。
set -u
LOG=/var/log/geohot-conc-guard.log
ENVF=/opt/geohot/app/.env
DISARM=/etc/geohot/conc-guard.disarmed
TRIPPED=/etc/geohot/conc-guard.tripped
FORCE=/etc/geohot/conc-guard.force
[ -f "$DISARM" ] && exit 0
[ -f "$TRIPPED" ] && exit 0
slow=0; detail=""
for p in /geohot/ /geohot/all.data /geohot/daily.data /geohot/weekly.data; do
  out=$(curl -s -o /dev/null -m 20 -w '%{time_total} %{http_code}' "http://127.0.0.1:3000$p" 2>/dev/null) || out="timeout 000"
  sec=${out%% *}; code=${out##* }
  case "$code" in 5*) detail="$detail $p=$code"; slow=$((slow+3));; esac
  if awk -v s="$sec" 'BEGIN{exit !(s+0>5.0)}'; then slow=$((slow+1)); detail="$detail $p=${sec}s"; fi
done
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
swap=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)
err5=$(sudo journalctl -u geohot-api -u geohot-web --since '-6 minutes' --no-pager 2>/dev/null | grep -cE ' 5[0-9][0-9] ')
cur=$(sudo sed -n 's/^ANALYZE_CONCURRENCY=//p' "$ENVF"); cur=${cur:-0}
bad=0
[ -f "$FORCE" ] && bad=1
[ "$slow" -ge 3 ] && bad=1
[ "$avail" -lt 40 ] && bad=1
[ "$swap" -gt 1400 ] && bad=1
[ "$err5" -ge 2 ] && bad=1
echo "$(date -Is) probe conc=$cur slow=$slow availMB=$avail swapMB=$swap err5xx6m=$err5 bad=$bad${detail:+ flags:$detail}" >> "$LOG"
if [ "$bad" = 1 ] && [ "$cur" -gt 4 ]; then
  sudo cp -a "$ENVF" "/opt/geohot/backups/env-guard-trip-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo sed -i 's/^ANALYZE_CONCURRENCY=.*/ANALYZE_CONCURRENCY=4/' "$ENVF"
  sudo systemctl restart geohot-worker
  sudo touch "$TRIPPED"
  echo "$(date -Is) TRIPPED conc $cur->4; guard disarmed until 'sudo rm /etc/geohot/conc-guard.tripped'" >> "$LOG"
fi
