#!/bin/bash
# 第 115 轮：把"停掉实时更新去排历史"做成机器自己会结束的窗口。
#
# 为什么要停：16:53 现读存量是 档案待判 14,691 ∶ 实时待判 1,409，而近 60 分钟判完 178 条里 **0 条属于一到九月**
# （`pgboss.job.state='completed'` join `articles.timeline_at` 现读）。实时带一直在吃那 4 个内存槽，
# 关进口是当下唯一能让档案带拿到全部槽位的动作——份额与门槛都不用改。
#
# 为什么不能手停就走：会话会结束，站长不会半夜来问"排完了没有"。所以这里装一把每 30 分钟自问的排空哨兵，
# 它自己判三件事：排空了→恢复；不健康了→立刻恢复（读者的命优先于历史）；到最迟期限→无论如何恢复。
# 三件事共用一份判据文件（$BIN/r114-drain-decide.sh）——**自测跑的就是生产要 source 的那一份**，
# 不复制第二份判据，免得"测的是一份、装的是一份"。
#
# 用法（都要 root）：
#   bash install-long-window.sh --selftest              # 不碰系统，只验判据与单元模板
#   bash install-long-window.sh --start                 # 先装并 enable 哨兵，再关阀（顺序不可反：先有回去的路再出门）
#   bash install-long-window.sh --restore               # 手工恢复并拆哨兵
#   bash install-long-window.sh --status                # 现读：阀、哨兵、剩余存量、最近判定
set -uo pipefail

BIN=${GEOHOT_BIN:-/opt/geohot/bin}
SYS=${SYSTEMD_SYS:-/etc/systemd/system}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
LOG=${R114_LOG:-/var/log/geohot-r114-longwindow.log}
WATCH=${R114_WATCH:-$BIN/r114-drain-watch.sh}
DECIDE=${R114_DECIDE:-$BIN/r114-drain-decide.sh}
STOPPER=${R114_STOPPER:-$BIN/r114-stop-realtime.sh}
REVERTER=${R114_REVERTER:-$BIN/r114-restore-realtime.sh}
DL_DEFAULT=$(date -d "2026-10-22 06:00:00" +%s 2>/dev/null || echo 0)
DEADLINE_EPOCH=${R114_DEADLINE_EPOCH:-$DL_DEFAULT}
FLOOR=${R114_FLOOR_AVAIL_MB:-90}
BUDGET=${R114_BUDGET_ERR5XX:-0}
STREAK_N=${R114_LOWMEM_STREAK:-2}

decide_body() { cat <<'DECIDE'
# 唯一一份窗口去留判据。只吃数字、不碰世界，所以每个分支都能被夹具走到。
#   $1 剩余待判(档案)  $2 可用内存 MB  $3 近读窗口内本站 5xx  $4 现在(epoch)  $5 最迟期限(epoch)
#   $6 已连续几次低内存（1 次不算——一次抽样不该结束窗口）
#   环境变量：GEOHOT_FLOOR_AVAIL_MB（内存地板，默认 90：114 轮整夜窗口里 availMB 最低也有 139，90 是"真的撑不住"）
#             GEOHOT_BUDGET_ERR5XX（5xx 预算，默认 0：读者的路一红就撤，历史让位）
#             GEOHOT_LOWMEM_STREAK（低内存要连续几次才撤，默认 2）
decide() {
  local left="${1:-0}" avail="${2:-0}" e5="${3:-0}" now="${4:-0}" deadline="${5:-0}" streak="${6:-1}"
  local floor="${GEOHOT_FLOOR_AVAIL_MB:-90}" budget="${GEOHOT_BUDGET_ERR5XX:-0}" need="${GEOHOT_LOWMEM_STREAK:-2}"
  # 读不到存量 = -1，绝不能当成"排空了"。这是这类哨兵最危险的假绿。
  if [ "$left" -le -1 ]; then echo "HOLD|unknown_left"; return; fi
  if [ "$left" -le 0 ]; then echo "RESTORE|drained"; return; fi
  if [ "$e5" -gt "$budget" ]; then echo "RESTORE|reader_5xx=$e5"; return; fi
  if [ "$avail" -lt "$floor" ]; then
    if [ "$streak" -ge "$need" ]; then echo "RESTORE|low_mem=${avail}MB streak=$streak"; return; fi
    echo "HOLD|low_mem=${avail}MB streak=$streak/$need"; return
  fi
  if [ "$deadline" -gt 0 ] && [ "$now" -ge "$deadline" ]; then echo "RESTORE|deadline"; return; fi
  echo "HOLD|left=$left avail=${avail}MB e5=$e5"
}
# 低内存计数：哨兵自己不记状态，靠 /run 里那一个数字。抽成函数是为了能被夹具测到（生产跑的与测的是同一份）。
#   $1 上次计数  $2 本次可用 MB  $3 可用 MB 数（坏值一律当 0）  $4 地板
next_streak() {
  local prev="${1:-0}" avail="${2:-0}" floor="${3:-90}"
  case "$prev" in ''|*[!0-9]*) prev=0 ;; esac
  case "$avail" in ''|*[!0-9]*) avail=0 ;; esac
  case "$floor" in ''|*[!0-9]*) floor=90 ;; esac
  if [ "$avail" -lt "$floor" ]; then echo $(( prev + 1 )); else echo 0; fi
}
DECIDE
}

watch_body() { cat <<'WATCH'
#!/bin/bash
# 每 30 分钟问一次：历史排完了吗？读者的路还顺吗？到期限了吗？
set -uo pipefail
LOG=${R114_LOG:-/var/log/geohot-r114-longwindow.log}
exec >> "$LOG" 2>&1
BIN=${GEOHOT_BIN:-/opt/geohot/bin}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
DEADLINE_EPOCH=${R114_DEADLINE_EPOCH:-0}
export GEOHOT_FLOOR_AVAIL_MB=${R114_FLOOR_AVAIL_MB:-90}
export GEOHOT_BUDGET_ERR5XX=${R114_BUDGET_ERR5XX:-0}
export GEOHOT_LOWMEM_STREAK=${R114_LOWMEM_STREAK:-2}
VALVE_FRESH_MIN=${R114_VALVE_FRESH_MIN:-90}
. "$BIN/r114-drain-decide.sh"
# 阀已经开着 ⇒ 窗口早结束了（多半是另一半或人工恢复的）。哨兵自己拆掉，不留着每小时白问。
# 但关阀不到 ${VALVE_FRESH_MIN} 分钟的"刚开回来"不算数——那时可能是关阀与本次读到的竞态，宁可再问一轮。
V=$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF" 2>/dev/null)
if [ "$V" = "COLLECT_ENABLED=true" ]; then
  NOW=$(date +%s)
  STOP_EPOCH=$(date -r /etc/geohot/r114-stop.done +%s 2>/dev/null || echo 0)
  if [ "$STOP_EPOCH" -le 0 ] || [ $(( NOW - STOP_EPOCH )) -ge $(( VALVE_FRESH_MIN * 60 )) ]; then
    echo "$(date -Is) watch-valve-open 阀已是 true（stop 旗标 $(cat /etc/geohot/r114-stop.done 2>/dev/null || echo 无)），哨兵自拆"
    systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
    exit 0
  fi
  echo "$(date -Is) watch-valve-open-fresh 阀刚开 $(( (NOW - STOP_EPOCH) / 60 )) 分钟（<${VALVE_FRESH_MIN}），先不拆哨兵"
  exit 0
fi
set -a; . "$ENVF" >/dev/null 2>&1; set +a
LEFT=$(PGOPTIONS="-c statement_timeout=20s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM articles a WHERE a.timeline_at < '2026-10-01+08' AND a.processing_state IN ('new','analyzed')" 2>/dev/null \
  | tail -1 | tr -dc '0-9')
[ -n "$LEFT" ] || LEFT=-1
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
# 低内存要连续两次才算：一次抽样就撤窗，等于把窗口交给最抖的那一格读数。
PREV=$(cat /run/geohot-r114-lowmem 2>/dev/null || echo 0)
STREAK=$(next_streak "$PREV" "${AVAIL:-0}" "$GEOHOT_FLOOR_AVAIL_MB")
mkdir -p /run 2>/dev/null && printf '%s' "$STREAK" > /run/geohot-r114-lowmem 2>/dev/null
E5=$(tail -n 4000 /var/log/nginx/access.log 2>/dev/null | awk -v d="$(date +%d/%b/%Y)" \
     'index($4, "[" d ":")==1 && substr($9,1,1)=="5" && index($7, "/geohot")>0 {c++} END {print c+0}')
ACT=$(decide "$LEFT" "${AVAIL:-0}" "${E5:-0}" "$(date +%s)" "${DEADLINE_EPOCH:-0}" "$STREAK")
echo "$(date -Is) watch left=$LEFT avail=${AVAIL:-?}MB lowmem_streak=$STREAK err5xx=${E5:-?} -> $ACT"
case "$ACT" in
  RESTORE*)
    R114_FORCE=1 bash "$BIN/r114-restore-realtime.sh"; rc=$?
    echo "$(date -Is) watch-restore rc=$rc ($ACT)"
    systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
    systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
    echo "$(date -Is) watch-done 哨兵与两枚窗口定时器已拆"
    ;;
esac
WATCH
}

unit_svc() { printf '[Unit]\nDescription=%s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nEnvironment=R114_DEADLINE_EPOCH=%s\nEnvironment=R114_FLOOR_AVAIL_MB=%s\nEnvironment=R114_BUDGET_ERR5XX=%s\nEnvironment=R114_LOWMEM_STREAK=%s\nExecStart=/bin/bash %s\n' "$2" "$3" "$4" "$5" "$6" "$7"; }
unit_tm() { printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30\nPersistent=false\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$2" "$3" "$1"; }

read_left() {
  set -a; . "$ENVF" >/dev/null 2>&1; set +a
  PGOPTIONS="-c statement_timeout=20s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM articles a WHERE a.timeline_at < '2026-10-01+08' AND a.processing_state IN ('new','analyzed')" 2>&1 | tail -1
}

MODE=${1:-}
case "$MODE" in
--selftest)
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  decide_body > "$T/decide.sh"; watch_body > "$T/watch.sh"
  bash -n "$T/decide.sh" && echo "  OK   判据语法过" || { echo "  WRONG 判据语法不过"; exit 1; }
  bash -n "$T/watch.sh"  && echo "  OK   哨兵语法过" || { echo "  WRONG 哨兵语法不过"; exit 1; }
  # 夹具跑的就是这份文件——生产的哨兵 source 的也是它（同一个 inode 的副本，不是重写第二遍）。
  . "$T/decide.sh"
  export GEOHOT_FLOOR_AVAIL_MB="$FLOOR" GEOHOT_BUDGET_ERR5XX="$BUDGET" GEOHOT_LOWMEM_STREAK="$STREAK_N"
  chk() { # chk <说明> <期望动作> <剩余> <可用> <5xx> <现在> <期限> <低内存连击>
    local got; got=$(decide "$3" "$4" "$5" "$6" "$7" "${8:-1}")
    case "$got" in
      "$2"*) echo "  OK   $1 → $got" ;;
      *) echo "  WRONG $1：期望 $2 得到 $got"; exit 1 ;;
    esac; }
  chk "排空（0 条）"            RESTORE 0    300 0 1000 2000 1
  chk "未排空且健康"            HOLD   1200  300 0 1000 2000 1
  chk "读者面出 5xx"            RESTORE 1200 300 3 1000 2000 1
  chk "低内存第一次（不算）"    HOLD   1200  60 0 1000 2000 1
  chk "低内存第二次（要撤）"    RESTORE 1200 60 0 1000 2000 2
  chk "到最迟期限"              RESTORE 1200 300 0 2500 2000 1
  chk "存量读不到（-1）"        HOLD     -1   300 0 1000 99999999999 1
  # 证这把尺真的有电：相邻的两个数必须给相反的答案。
  chk "只差一条就不算排空"      HOLD      1   300 0 1000 2000 1
  chk "5xx 预算 0 时一条也算红" RESTORE 1200 300 1 1000 2000 1
  # 计数器本身也要测：坏读数（空、非数字）不能把窗口拖垮，也不能让它一次抖动就撤窗。
  [ "$(next_streak 0 60 90)" = 1 ]      && [ "$(next_streak 1 60 90)" = 2 ]      && [ "$(next_streak 2 300 90)" = 0 ] \
    && echo "  OK   next_streak：60→1、再 60→2、回到 300 归零" || { echo "  WRONG 低内存计数器不对"; exit 1; }
  [ "$(next_streak '' 60 90)" = 1 ] && [ "$(next_streak x y 90)" = 1 ] && echo "  OK   坏读数（空/非数字）当 0 处理：仍从第一次算起，不会直接撤窗" \
    || { echo "  WRONG 坏读数没被兜住"; exit 1; }
  unit_tm geohot-r114-drain-watch "d" "*:00/30" > "$T/watch.timer"
  grep -q 'WantedBy=timers.target' "$T/watch.timer" && echo "  OK   哨兵 timer 带 [Install]（enable 得动）" || { echo "  WRONG timer 缺 [Install]"; exit 1; }
  grep -q 'Persistent=false' "$T/watch.timer" && echo "  OK   Persistent=false（错过一轮不补跑）" || { echo "  WRONG 哨兵会补跑"; exit 1; }
  unit_svc geohot-r114-drain-watch "d" 1700000000 90 0 2 "$BIN/x.sh" > "$T/watch.service"
  grep -q 'Environment=R114_DEADLINE_EPOCH=' "$T/watch.service" && echo "  OK   期限与两个阈值经 Environment= 传进单元（不写死在脚本里）" || { echo "  WRONG 单元没带阈值"; exit 1; }
  echo "  INFO 本次阈值：内存地板 ${FLOOR} MB ∶ 5xx 预算 ${BUDGET} 条（尾读 4000 行）∶ 期限 epoch $DEADLINE_EPOCH"
  [ "$DEADLINE_EPOCH" -gt "$(date +%s)" ] || echo "  NOTE 期限不在将来 —— --start 会拒绝这个值"
  echo SELFTEST_OK
  ;;
--start)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  [ "$DEADLINE_EPOCH" -gt "$(date +%s)" ] || { echo "REFUSE 最迟期限 epoch=$DEADLINE_EPOCH 不在将来（R114_DEADLINE_EPOCH 给错了）"; exit 1; }
  bash "$0" --selftest || { echo "REFUSE 自测不过，不装也不关阀"; exit 1; }
  [ -x "$STOPPER" ] && [ -x "$REVERTER" ] || { echo "REFUSE 关阀/恢复两半不在 $BIN（先跑 install-night-window.sh --install）"; exit 1; }
  case "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" in
    COLLECT_ENABLED=true) : ;;
    *) echo "REFUSE 阀门现值不是 true：$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")（只从'正在实时'进窗口）"; exit 1;;
  esac
  mkdir -p "$BIN"
  decide_body > "$DECIDE.tmp" && mv "$DECIDE.tmp" "$DECIDE"; chmod 700 "$DECIDE"; chown root:root "$DECIDE"
  watch_body  > "$WATCH.tmp"  && mv "$WATCH.tmp"  "$WATCH";  chmod 700 "$WATCH";  chown root:root "$WATCH"
  ls -l "$DECIDE" "$WATCH" | awk '{print $1, $5, $9}'
  unit_svc geohot-r114-drain-watch "GEOHOT long-window drain sentinel" "$DEADLINE_EPOCH" "$FLOOR" "$BUDGET" "$STREAK_N" "$WATCH" > "$SYS/geohot-r114-drain-watch.service"
  unit_tm  geohot-r114-drain-watch "GEOHOT long-window drain sentinel (30 min)" "*:00/30" > "$SYS/geohot-r114-drain-watch.timer"
  systemctl daemon-reload
  systemd-analyze calendar "*:00/30" | head -2
  systemctl enable --now geohot-r114-drain-watch.timer || { echo "REFUSE 哨兵 enable 失败，阀门不动"; exit 1; }
  echo "SENTINEL_ARMED $(systemctl is-enabled geohot-r114-drain-watch.timer)/$(systemctl is-active geohot-r114-drain-watch.timer)"
  R114_FORCE=1 bash "$STOPPER"; rc=$?
  echo "STOP_RC=$rc"
  [ "$rc" = 0 ] || { echo "关阀退 $rc：哨兵已装但窗口没开，请人工看 $LOG；现值 $(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")"; exit 1; }
  printf 'valve=%s worker=%s archive_timer=%s watch=%s\n' "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)" "$(systemctl is-active geohot-r114-drain-watch.timer)"
  echo "LONG_WINDOW_OPEN 剩余存量由哨兵每 30 分钟读一次：排空/5xx/低内存/过期限 都恢复"
  ;;
--restore)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  R114_FORCE=1 bash "$REVERTER"; rc=$?
  systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
  systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
  printf 'RESTORE_RC=%s valve=%s worker=%s archive_timer=%s\n' "$rc" "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)"
  ;;
--status)
  printf 'valve=%s worker=%s archive_timer=%s reprint=%s watch=%s/%s\n' "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)" \
    "$(systemctl is-active geohot-reprint-today.timer)" \
    "$(systemctl is-enabled geohot-r114-drain-watch.timer 2>&1)" "$(systemctl is-active geohot-r114-drain-watch.timer 2>&1)"
  echo "left=$(read_left)"
  tail -8 "$LOG" 2>/dev/null || echo "（还没有长窗口日志）"
  ;;
*) echo "用法: $0 --selftest|--start|--restore|--status"; exit 2;;
esac
