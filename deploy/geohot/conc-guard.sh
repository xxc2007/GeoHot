#!/bin/bash
# GEOHOT 读者面守护：判定并发（ANALYZE_CONCURRENCY）高于 4、或翻译腿并发（GEOHOT_TRANSLATE_CONCURRENCY）
# 高于 3 时，一旦读者面或内存出现退化，就把越过地板的那一路降回来并停机自锁。
# 装法（这台机器已装，模板与线上逐字节一致）：
#   sudo install -m 755 deploy/geohot/conc-guard.sh /opt/geohot/bin/conc-guard.sh
#   sudo cp deploy/geohot/systemd/geohot-conc-guard.{service,timer} /etc/systemd/system/
#   sudo daemon-reload && sudo systemctl enable --now geohot-conc-guard.timer
# 判据（阈值都是可调变量，方便"在必然命中的样本上证活"，默认值就是线上那一条）：
#   一次探测里 4 个读者面，>SLOW_MS(默认 5000ms) 的样本数 ≥SLOW_MIN(默认 2)，或任一 >FLOOR_MS(默认 8000ms)，
#   或 MemAvailable<AVAIL_MIN(40 MB)，或已用 swap>SWAP_MAX(1400 MB)，或 6 分钟内 5xx ≥ERR5_MIN(2)。
#   默认值怎么来的：2026-10-16 实测 8 槽时首页出现过 5.3 s 与 7.0 s 各一次、6 槽时最差 2.1 s，
#   而 api.server.ts 的读者侧超时是 15 s——8 s 就是"离 503 只差一次抖动"的那条硬线。
#   当天正常现值：慢样本 0/18、MemAvailable 75–227 MB、swap 671–920 MB、5xx 0，不会误触发。
# 证活分两步（新判据必须两步都跑过，只有 FORCE 那一步会留下"能执行"却没有"能区分"）：
#   判别：sudo DRY=1 SLOW_MS=4000 bash /opt/geohot/bin/conc-guard.sh   → 日志该出现 bad=1 且"本应触发"，且**不动生产**
#   动作：sudo touch /etc/geohot/conc-guard.force && sudo bash /opt/geohot/bin/conc-guard.sh
#         → 实测它把 8 降到 4、重启 worker、写 env-guard-trip-* 备份并自锁；测完删掉 force 与 tripped
# 触发过就必须人工复位：
#   sudo rm /etc/geohot/conc-guard.tripped && sudo systemctl start geohot-conc-guard.timer
#   再把 .env 的 ANALYZE_CONCURRENCY 调回去并重启 geohot-worker
# 这个单元刻意**不加沙箱**（NoNewPrivileges 会让 sudo 失效，ProtectSystem=strict 会挡住改写 .env）：
# 它唯一的职责就是改一个环境变量再重启 geohot-worker，写动作只有两处、都在本文件里。沙箱化归工单 #200。
set -u
LOG=/var/log/geohot-conc-guard.log
ENVF=/opt/geohot/app/.env
DISARM=/etc/geohot/conc-guard.disarmed
TRIPPED=/etc/geohot/conc-guard.tripped
FORCE=/etc/geohot/conc-guard.force
SLOW_MS=${SLOW_MS:-5000}; SLOW_MIN=${SLOW_MIN:-2}; FLOOR_MS=${FLOOR_MS:-8000}
AVAIL_MIN=${AVAIL_MIN:-40}; SWAP_MAX=${SWAP_MAX:-1400}; ERR5_MIN=${ERR5_MIN:-2}
DRY=${DRY:-0}
[ -f "$DISARM" ] && exit 0
[ -f "$TRIPPED" ] && exit 0
slow=0; floored=0; http5=0; detail=""
for p in /geohot/ /geohot/all.data /geohot/daily.data /geohot/weekly.data; do
  out=$(curl -s -o /dev/null -m 20 -w '%{time_total} %{http_code}' "http://127.0.0.1:3000$p" 2>/dev/null) || out="20.0 000"
  sec=${out%% *}; code=${out##* }
  ms=$(awk -v s="$sec" 'BEGIN{printf "%d", s*1000}')
  case "$code" in
    5*) detail="$detail $p=http$code"; http5=$((http5+1)) ;;   # 5xx 不是"慢"，是已经打不出去：单独计，直接算命中
    000) detail="$detail $p=unreachable" ;;
  esac
  if awk -v m="$ms" -v t="$SLOW_MS" 'BEGIN{exit !(m>=t)}'; then slow=$((slow+1)); detail="$detail $p=${ms}ms"; fi
  if awk -v m="$ms" -v t="$FLOOR_MS" 'BEGIN{exit !(m>=t)}'; then floored=1; detail="$detail $p>${FLOOR_MS}ms-floor"; fi
done
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
swap=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)
err5=$(sudo journalctl -u geohot-api -u geohot-web --since '-6 minutes' --no-pager 2>/dev/null | grep -cE ' 5[0-9][0-9] ')
cur=$(sudo sed -n 's/^ANALYZE_CONCURRENCY=//p' "$ENVF"); cur=${cur:-0}
# 翻译腿的并发也要一起看：第一百零四轮把它从默认 3 抬到 5 换双语覆盖率，读者面一退化就得一起降回来。
# `tr -dc` 是防"值里带了注释或空格"把下面的 `-gt` 变成语法错，读不回来时按代码默认值 3 算。
tr_cur=$(sudo sed -n 's/^GEOHOT_TRANSLATE_CONCURRENCY=//p' "$ENVF" | tr -dc '0-9'); tr_cur=${tr_cur:-3}
bad=0; why=""
[ -f "$FORCE" ] && { bad=1; why="$why force"; }
[ "$http5" -ge 1 ] && { bad=1; why="$why http5xx=$http5"; }
[ "$slow" -ge "$SLOW_MIN" ] && { bad=1; why="$why slow=$slow"; }
[ "$floored" = 1 ] && { bad=1; why="$why floor"; }
[ "$avail" -lt "$AVAIL_MIN" ] && { bad=1; why="$why avail=${avail}MB"; }
[ "$swap" -gt "$SWAP_MAX" ] && { bad=1; why="$why swap=${swap}MB"; }
[ "$err5" -ge "$ERR5_MIN" ] && { bad=1; why="$why err5xx=$err5"; }
echo "$(date -Is) probe conc=$cur translate=$tr_cur slow=$slow availMB=$avail swapMB=$swap err5xx6m=$err5 bad=$bad${why:+ why:$why}${detail:+ seen:$detail}" >> "$LOG"
if [ "$bad" = 1 ] && { [ "$cur" -gt 4 ] || [ "$tr_cur" -gt 3 ]; }; then
  if [ "$DRY" = 1 ]; then
    echo "$(date -Is) DRY: would drop conc=$cur->4 translate=$tr_cur->3 (no write, no restart)" >> "$LOG"
    exit 0
  fi
  sudo cp -a "$ENVF" "/opt/geohot/backups/env-guard-trip-$(date -u +%Y%m%dT%H%M%SZ)"
  # 只改**已存在**的那一行，绝不追加。2026-10-16 亲测：这个文件的最后一行没有换行符，
  # 追加会把新变量粘进上一行的值里（那次弄坏的是 WORKBUDDY_CN_API_KEY，值变成了
  # `local-workbuddyGEOHOT_…`）。变量不在文件里就等于取代码默认值，而那已经是这里的地板，不写才对。
  [ "$cur" -gt 4 ] && sudo sed -i 's/^ANALYZE_CONCURRENCY=.*/ANALYZE_CONCURRENCY=4/' "$ENVF"
  [ "$tr_cur" -gt 3 ] && sudo sed -i 's/^GEOHOT_TRANSLATE_CONCURRENCY=.*/GEOHOT_TRANSLATE_CONCURRENCY=3/' "$ENVF"
  sudo systemctl restart geohot-worker
  sudo touch "$TRIPPED"
  echo "$(date -Is) TRIPPED conc $cur->$([ "$cur" -gt 4 ] && echo 4 || echo keep) translate $tr_cur->$([ "$tr_cur" -gt 3 ] && echo 3 || echo keep); guard disarmed until 'sudo rm /etc/geohot/conc-guard.tripped'" >> "$LOG"
fi
