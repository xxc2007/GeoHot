#!/bin/bash
# 第 115 轮的读者优先闸门：读者的路一红，就把 geohot-worker（判定腿＋翻译腿）按停一段冷却，
# 而不是只恢复实时——18:27 实测：停 worker ⇒ 首页 503/15.3 s → 200/0.076 s，pg 后端 21→10、负载 1.73→0.38；
# 而只关阀（17:47 那次）读者面照旧红。真正的负载旋钮是这个进程，不是阀门。
set -uo pipefail
LOG=${R115_LOG:-/var/log/geohot-r115-readergate.log}
exec >> "$LOG" 2>&1
BIN=${GEOHOT_BIN:-/opt/geohot/bin}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
RUN=${R115_RUN:-/run/geohot-r115-gate}
DISARM=${R115_DISARM:-/etc/geohot/r115-gate.disarmed}
BUDGET=${R115_BUDGET_ERR5XX:-0}
WIN=${R115_E5_WINDOW_SEC:-700}
COOL=${R115_COOLDOWN_MIN:-10}
. "$BIN/r114-drain-decide.sh"
# 判据文件必须是带 gate_action 的那一份。18:53 装机时它还是 18:25 那版（没有这个函数），
# 于是每次运行只留下一行 command not found、case 谁都匹配不上、什么也不做——一个安静失效的假闸门。
declare -F gate_action >/dev/null || { echo "$(date -Is) FATAL 判据文件缺 gate_action（先 --refresh 或 --gate-on 重装判据）"; exit 1; }
declare -F e5_count >/dev/null || { echo "$(date -Is) FATAL 判据文件缺 e5_count"; exit 1; }
NOW=$(date +%s); T0=$(date -d "today 00:00:00" +%s 2>/dev/null || echo 0)
# Repeated degradation within an hour keeps the old, longer backoff.
LAST_RELEASE=$(cat "${RUN}.last-release" 2>/dev/null || echo 0)
# 2026-11-04 决策：默认从"停整个 worker"改成"冻住取任务"。线上 24 小时停了 15 次、合计 392 分钟，
# 每次 stop 之后的重启又会在 upstream 换血时回一批 502，于是下一次 5xx 立刻再触发一次。
# fence 模式下闸门只写 /run/geohot-r115-fence（第一段是冷却截止 epoch），进程留在原地、不再领新任务，
# 在飞的任务照常落地写回执。R115_ACTION=stop 保留为回退档。
MODE=${R115_ACTION:-fence}
FENCE=${GEOHOT_R115_FENCE:-/run/geohot-r115-fence}

case "$LAST_RELEASE" in ''|*[!0-9]*) LAST_RELEASE=0 ;; esac
if (( LAST_RELEASE > 0 && NOW - LAST_RELEASE < 3600 && COOL < 30 )); then COOL=30; fi
# **重启宽限**（2026-11-04）：单元重启那一两分钟里 nginx 对正在换血的 upstream 回 502/503。
# 09:23 一次部署攒出 12 条 5xx ⇒ 闸门把 worker 停了 30 分钟，那不是读者受害，是我们自己在重启。
# 取 api/web/worker 最近一次 ActiveEnterTimestamp，落在窗口内就排除 [重启-180s, 重启+GRACE（默认 600s）] 这段；
# 300s/120s 在 2026-11-04 16:06 那次部署上仍漏了 3 条（TRIPPED 5xx=6 grace=3）：一次部署要 90–150 秒，
# 而 nginx 对换血中的 upstream 回 502 常落在最后一次 restart 之后，所以默认放宽，真读者的 5xx 照旧 0 容忍；
# 真读者的 5xx 发生在别的时刻，照旧计数。R115_RESTART_GRACE_SEC=0 可关回原行为。
GRACE=${R115_RESTART_GRACE_SEC:-600}
case "$GRACE" in ''|*[!0-9]*) GRACE=600 ;; esac
EXF=0; EXT=0
if (( GRACE > 0 )); then
  # 一次部署是**滚动重启**：api 先起、web 后起，只取"最后一个"单元的时刻会漏掉前一半的 5xx。
  # 所以取窗口内所有重启的最早与最晚，用一整段 [最早-15s, 最晚+GRACE] 覆盖这次换血。
  for U in geohot-api geohot-web geohot-worker; do
    TS=$(systemctl show -p ActiveEnterTimestamp --value "$U" 2>/dev/null || true)
    [ -n "${TS:-}" ] || continue
    E=$(date -d "$TS" +%s 2>/dev/null || true)
    case "${E:-}" in ''|*[!0-9]*) continue ;; esac
    (( E > NOW - WIN )) || continue
    if (( EXF == 0 || E - 180 < EXF )); then EXF=$(( E - 180 )); fi
    if (( E + GRACE > EXT )); then EXT=$(( E + GRACE )); fi
  done
fi
# 部署自己的换血窗口：deploy.sh 在重启前/后各写一个 epoch 到 /run/geohot-deploy-window，
# 单靠单元的 ActiveEnterTimestamp 不足以覆盖"最后一次 restart 之前"的 502（实测 03:5x 那次部署
# 就是 api/web 先起的 502 落在 [最晚-180s] 之前，闸门照样 TRIP、把 worker 冻了 30 分钟）。
DW=/run/geohot-deploy-window
# 部署窗口与重启宽限是两件事：GRACE=0（关掉按单元时间戳算的宽限）时，部署自己写的窗口
# 也必须照样生效，否则「关宽限」会连带关掉唯一可靠的排除手段。
if [ -r "$DW" ]; then
  # 两行各一个 epoch（deploy.sh 先写开始、验收前再追加结束）。`read -r DS DE < 文件` 只读
  # **第一行**，结束那个 epoch 从来没被看见过——2026-11-05 复核：DE 恒为空，窗口被当成
  # "还没关"，右端取 NOW，于是每次部署之后 1300 秒内的 5xx 全被当自家重启排掉。
  DS=$(sed -n '1p' "$DW" 2>/dev/null || true)
  DE=$(sed -n '2p' "$DW" 2>/dev/null || true)
  case "${DS:-}" in ''|*[!0-9]*) DS=0 ;; esac
  case "${DE:-}" in ''|*[!0-9]*) DE=0 ;; esac
  # **部署还在跑的时候，文件里只有开始那个 epoch**（结束那个要等验收前才追加）。
  # 06:40–06:42 那次就是这一段：重启全在窗口里，闸门只认"两个 epoch 都在"的文件，
  # 于是把自家人打出来的 6 条 5xx 记成读者事故、冻 10 分钟。单值即视为"窗口还没关"，
  # 右端取 NOW（再看不超过冷却小时的合理范围，防止一个旧文件长期把闸门蒙住）。
  if (( DE == 0 && DS > 0 && DS >= NOW - WIN - GRACE )); then DE=$(( NOW > DS ? NOW : DS )); fi
  if (( DE > 0 && DE >= NOW - WIN - GRACE )); then
    (( DS - 60 < EXF || EXF == 0 )) && EXF=$(( DS - 60 ))
    (( DE + 60 > EXT )) && EXT=$(( DE + 60 ))
  fi
fi
# 提前释放之后，窗口里那批 5xx 已经付过一次代价：否则会「释放 → 立刻重新冻结」打转——
# 2026-11-06 08:01–08:10 现场就是 FENCED / RELEASED-EARLY / FENCED 每三分钟来一次，
# 每次都把 worker 冻住 30 分钟、又被健康样本放出来。释放时刻之后的新 5xx 照样计数。
if (( LAST_RELEASE > 0 && LAST_RELEASE > NOW - WIN )); then
  (( LAST_RELEASE > EXF )) && EXF=$LAST_RELEASE
fi
export R114_E5_EXCLUDE_FROM=$EXF R114_E5_EXCLUDE_TO=$EXTRAO=$(e5_count "${R114_NGX:-/var/log/nginx/access.log}" "${R114_E5_TAIL:-20000}" "$WIN" \
  "$(LC_ALL=C date +%d/%b/%Y)" "$T0" "$NOW" \
  "$(LC_ALL=C date -d yesterday +%d/%b/%Y 2>/dev/null)" "$(( T0 - 86400 ))")
E5=$(printf '%s' "$RAO" | cut -d' ' -f1)
SPAN=$(printf '%s' "$RAO" | cut -d' ' -f3)
GRACED=$(printf '%s' "$RAO" | cut -d' ' -f4)
case "$GRACED" in ''|*[!0-9]*) GRACED=0 ;; esac
case "$E5" in ''|*[!0-9-]*) E5=-1 ;; esac
# 状态前两列兼容旧文件：冷却截止 epoch 与本闸门是否承担恢复责任（1/0）。
# 第三列 stop-pending 表示停止意图已提交，并不谎称 stop 已成功；旧两列文件照常恢复。
UNTIL=$(cut -d' ' -f1 "$RUN" 2>/dev/null || echo 0)
WE=$(cut -d' ' -f2 "$RUN" 2>/dev/null || echo 0)
ACT=$(systemctl is-active geohot-worker 2>&1); ACT_RC=$?
ACTION_ACT="$ACT"
# 不能把失败探针偶然打出的 active 当成可认领的健康 worker；已有责任仍走恢复路径。
[ "$ACT_RC" -eq 0 ] || ACTION_ACT=unknown
DIS=0; [ -e "$DISARM" ] && DIS=1
V=$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF" 2>/dev/null)
A=$(gate_action "$E5" "$NOW" "${UNTIL:-0}" "${WE:-0}" "$ACTION_ACT" "$BUDGET" "$DIS")
case "$A" in
  TRIP)
    [ "${R115_DRY:-0}" = 1 ] || rm -f /run/geohot-r115-ready
    if [ "${R115_DRY:-0}" = 1 ]; then
      echo "$(date -Is) DRY-TRIP 本会停 worker（现在没停）5xx=$E5/${WIN}s(样本 $SPAN) valve=$V worker=$ACT"
    else
      # 先持久化恢复责任再执行 stop。临时文件与 RUN 同目录，rename 失败仍保留旧记录。
      INTENT_TMP=$(umask 077; mktemp -- "${RUN}.tmp.XXXXXX") \
        || { echo "$(date -Is) TRIP-STATE-FAILED 无法准备停止意图，未 stop"; exit 1; }
      if ! { chmod 600 "$INTENT_TMP" && printf '%s 1 stop-pending\n' "$(( NOW + COOL * 60 ))" > "$INTENT_TMP" \
        && mv -fT -- "$INTENT_TMP" "$RUN"; }; then
        rm -f -- "$INTENT_TMP"
        echo "$(date -Is) TRIP-STATE-FAILED 无法提交停止意图，原责任保留，未 stop"
        exit 1
      fi
      if [ "$MODE" = fence ]; then
        # 冻结：进程活着、不领新任务；在飞任务自己落地。恢复不需要重启，也就不会再有重启 502。
        printf '%s 1 fence
' "$(( NOW + COOL * 60 ))" > "$FENCE" || { echo "$(date -Is) FENCE-FAILED 无法写 $FENCE"; exit 1; }
        echo "$(date -Is) FENCED 5xx=$E5/${WIN}s(样本 $SPAN) grace=$GRACED valve=$V worker=$ACT 冻结 ${COOL} 分钟（进程不重启）"
        exit 0
      fi
      systemctl stop geohot-worker; RC=$?
      ACT=$(systemctl is-active geohot-worker 2>&1); ACTIVE_RC=$?
      # 停止意图已经承担恢复责任；stop/读回失败也保留它，下一轮按 active/inactive 收口。
      if [ "$RC" -eq 0 ] && [ "$ACTIVE_RC" -eq 3 ] && [ "$ACT" = inactive ]; then
        echo "$(date -Is) TRIPPED 5xx=$E5/${WIN}s(样本 $SPAN) grace=$GRACED valve=$V worker=$ACT stop_rc=$RC 冷却 ${COOL} 分钟"
      else
        echo "$(date -Is) TRIP-FAILED worker=$ACT stop_rc=$RC active_rc=$ACTIVE_RC stop-pending 恢复责任保留"
        exit 1
      fi
    fi
    ;;
  RELEASE|CONFIRM_RELEASE)
    if [ "${R115_DRY:-0}" = 1 ]; then
      echo "$(date -Is) DRY-RELEASE action=$A worker=$ACT（本轮只判不动）"
    else
      MAINT=$(systemctl show geohot-magpie-update.service -p ActiveState --value 2>/dev/null || echo unknown)
      if { [ -e /var/lib/geohot-maintenance/worker-owner.json ] && [ "$MAINT" != inactive ] && [ "$MAINT" != failed ]; } || ! /bin/bash "$BIN/reader-recovery-ready.sh"; then
        echo "$(date -Is) RECOVERY-WAIT 健康连续确认未满足，保留恢复责任"
        exit 0
      fi
      if [ "$MODE" = fence ]; then
        rm -f -- "$FENCE" || { echo "$(date -Is) RELEASE-FAILED worker=$ACT 栅栏文件删不掉"; exit 1; }
        printf '%s
' "$NOW" > "${RUN}.last-release"
        rm -f "$RUN" 2>/dev/null || true
        # 文案必须与事实一致：fence 档的承诺是"由本闸门释放时进程没被停过"，
        # 而不是"此刻一定在跑"——运维重启期间 worker=$ACT 会是 inactive，
        # 写成"进程一直在跑"会让复盘时误判是谁停的（2026-11-04 19:13 那条就这样）。
        if [ "$ACT" = active ]; then
          echo "$(date -Is) RELEASED 5xx=0/${WIN}s(样本 $SPAN) worker=$ACT mode=fence（本闸门未停进程）"
        else
          echo "$(date -Is) RELEASED 5xx=0/${WIN}s(样本 $SPAN) worker=$ACT mode=fence（进程由他人停/重启，非本闸门）"
        fi
        exit 0
      fi
      RC=0
      if [ "$A" = RELEASE ]; then systemctl start geohot-worker; RC=$?; fi
      ACT=$(systemctl is-active geohot-worker 2>&1); ACTIVE_RC=$?
      # 启动回执与实际读回都成功才交清恢复责任；已有 active 也要重新读回。
      # 失败留原状态，下一轮会重试启动，或确认已恢复的 worker 后再清责任。
      if [ "$RC" -eq 0 ] && [ "$ACTIVE_RC" -eq 0 ] && [ "$ACT" = active ]; then
        rm -f "$RUN" 2>/dev/null || { echo "$(date -Is) RELEASE-STATE-FAILED worker=$ACT 状态文件保留待重试"; exit 1; }
        printf '%s\n' "$NOW" > "${RUN}.last-release"
        echo "$(date -Is) RELEASED 5xx=0/${WIN}s(样本 $SPAN) worker=$ACT start_rc=$RC"
      else
        echo "$(date -Is) RELEASE-FAILED worker=$ACT start_rc=$RC active_rc=$ACTIVE_RC 状态文件保留待重试"
        exit 1
      fi
    fi
    ;;
  HELD)
    # A queued maintenance restart can race a previous stop transaction. An owned cooldown
    # remains a stop intent; reassert it without changing its deadline or recovery owner.
    if [ "$MODE" = fence ]; then
      if [ ! -e "$FENCE" ] && [ "$UNTIL" -gt "$NOW" ] && [ "${R115_DRY:-0}" != 1 ]; then
        printf '%s 1 fence
' "$UNTIL" > "$FENCE" || true
        echo "$(date -Is) HELD-FENCE-REASSERTED until=$UNTIL"
      fi
    elif [ "$WE" = 1 ] && [ "$ACT" = active ] && [ "${R115_DRY:-0}" != 1 ]; then
      systemctl stop --no-block geohot-worker
      echo "$(date -Is) HELD-STOP-SUBMITTED rc=$? worker=$ACT 恢复责任保留"
    fi
    # 冷却期里读者面已经连续健康就没必要把整条流水线关到冷却结束。
    # 2026-11-06 02:1x 现场：fence 从 01:56 一路 HELD 到 02:26，analyze 队列 7,463 条一条没动，
    # 而同一时刻首页 0.37s、recovery-ready 每分钟都在写健康样本 —— 等的只是那个计时器。
    MIN_HOLD=${R115_MIN_HOLD_SEC:-180}
    if [ "$MODE" = fence ] && [ -e "$FENCE" ] && [ "${R115_DRY:-0}" != 1 ] \
      && [ "$ACT" = active ] \
      && [ $(( NOW - (UNTIL - COOL * 60) )) -ge "$MIN_HOLD" ] \
      && /bin/bash "$BIN/reader-recovery-ready.sh"; then
      rm -f -- "$FENCE" && {
        printf '%s\n' "$NOW" > "${RUN}.last-release"
        echo "$(date -Is) RELEASED-EARLY 5xx=${E5}/${WIN}s 冷却还剩 $(( (UNTIL - NOW) / 60 )) 分钟但读者面已连续健康 worker=$ACT"
        rm -f "$RUN" 2>/dev/null || true
        exit 0
      }
    fi
    echo "$(date -Is) HELD 冷却还剩 $(( (UNTIL - NOW) / 60 )) 分钟 worker=$ACT 5xx=${E5}/${WIN}s"
    ;;
  SKIP_BLIND)
    echo "$(date -Is) SKIP 5xx 量具读不到（nginx 无当日样本或字段漂移）——闸门不动生产，但这不是绿灯" ;;
  SKIP_DISARMED) echo "$(date -Is) SKIP disarmed 旗标在 $DISARM" ;;
  SKIP_OPERATOR_STOPPED) echo "$(date -Is) SKIP worker=$ACT 非本闸门停止，5xx=$E5，不认领恢复责任" ;;
  *) echo "$(date -Is) IDLE 5xx=${E5}/${WIN}s(样本 $SPAN) grace=$GRACED worker=$ACT valve=$V 冷却文件=[$(cat "$RUN" 2>/dev/null)]" ;;
esac
