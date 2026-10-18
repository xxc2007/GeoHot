#!/bin/bash
# 第 114 轮夜窗机制的仓库侧副本 + 安装器。
#
# 为什么要进仓库：昨夜真的在跑的四枚单元（stop/restore/heal/refresh）与两条脚本从来只存在于机器上，
# GitHub 里没有（`verify-deploy` 因此常年报 DRIFT）。14:5x 现读它们已经从机上消失了
# （`systemctl is-enabled geohot-r114-{pause,restore,sample,verify}.timer` 全部 No such file or directory），
# 于是"续开夜窗"从改一个开关变成了要重写一遍机制。内容是从昨天 05:04 那次 `cat -n` 的捕获里逐行还原的，
# 不是凭记忆重写的——还原件必须自带证明，所以这条脚本有 --selftest。
#
# 用法：
#   bash deploy/geohot/night-window/install-night-window.sh --selftest   # 不碰系统，只验还原件
#   bash deploy/geohot/night-window/install-night-window.sh --install    # 落盘脚本与单元，不 enable
#   bash deploy/geohot/night-window/install-night-window.sh --arm        # enable 两枚 timer（今晚就会关阀）
#   bash deploy/geohot/night-window/install-night-window.sh --disarm     # disable --now 两枚 timer
set -uo pipefail

BIN=/opt/geohot/bin
SYS=/etc/systemd/system
ENVF=${R114_ENVF:-/opt/geohot/app/.env}

stop_body() { cat <<'STOP'
#!/bin/bash
# round-114: close the realtime intake so the archive band owns all judgement slots.
# Guards: (1) a clock window -- a boot-time replay of a Persistent timer must never
# be able to close the valve, only the 21:xx elapse may; (2) refuse-and-revert if the
# valve/worker do not come back as intended, so a failed stop leaves the site ON.
set -uo pipefail
LOG=${R114_LOG:-/var/log/geohot-r114-window.log}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
exec >> "$LOG" 2>&1
echo "$(date -Is) stop-begin"
H=$(date +%H)
case "$H" in 21|22) : ;; *)
  echo "$(date -Is) stop-skipped hour=$H -- closing the valve is only legal at 21:xx-22:xx"
  exit 0;; esac
if [ "${R114_DRY:-0}" = 1 ]; then
  echo "$(date -Is) stop-dryrun would: COLLECT_ENABLED=false + restart geohot-worker + stop geohot-archive.timer"
  exit 0
fi
sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=false/' "$ENVF"
systemctl restart geohot-worker
systemctl stop geohot-archive.timer
sleep 20
if ! grep -qx 'COLLECT_ENABLED=false' "$ENVF" || ! systemctl is-active --quiet geohot-worker; then
  echo "$(date -Is) stop-FAILED -> reverting to ON (a half-stopped window is worse than no window)"
  sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=true/' "$ENVF"
  systemctl restart geohot-worker
  systemctl start geohot-archive.timer
  exit 1
fi
touch "/etc/geohot/r114-stop.done.$(date +%F)"
systemctl disable --now geohot-r114-stop.timer 2>/dev/null
echo "$(date -Is) stopped [$(grep -E '^COLLECT_ENABLED=' "$ENVF")] worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
echo "$(date -Is) stop-end"
STOP
}

restore_body() { cat <<'RESTORE'
#!/bin/bash
# round-114: put realtime collection back. Idempotent and gated: the flags and the
# timer disables happen only AFTER the valve, the worker and the archive timer are all
# proven good, so a failed restore stays retryable instead of self-erasing.
set -uo pipefail
LOG=${R114_LOG:-/var/log/geohot-r114-window.log}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
exec >> "$LOG" 2>&1
echo "$(date -Is) restore-begin"
if [ "${R114_DRY:-0}" = 1 ]; then
  echo "$(date -Is) restore-dryrun valve=$(grep -E '^COLLECT_ENABLED=' "$ENVF") worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
  exit 0
fi
sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=true/' "$ENVF"
systemctl restart geohot-worker
systemctl reset-failed geohot-archive.service 2>/dev/null
systemctl start geohot-archive.timer
ok=0
for _ in 1 2 3 4 5 6; do
  sleep 10
  if grep -qx 'COLLECT_ENABLED=true' "$ENVF" && systemctl is-active --quiet geohot-worker \
     && systemctl is-active --quiet geohot-archive.timer; then ok=1; break; fi
  echo "$(date -Is) restore-retrying worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
done
if [ "$ok" != 1 ]; then
  echo "$(date -Is) restore-FAILED valve=$(grep -E '^COLLECT_ENABLED=' "$ENVF") worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer) -- leaving geohot-r114-heal.timer armed"
  exit 1
fi
touch "/etc/geohot/r114-restore.done.$(date +%F)"
systemctl disable --now geohot-r114-restore.timer 2>/dev/null
systemctl disable --now geohot-r114-refresh.timer 2>/dev/null
systemctl disable --now geohot-r114-heal.timer 2>/dev/null
systemctl disable --now geohot-r114-verify.timer 2>/dev/null
echo "$(date -Is) restored [$(grep -E '^COLLECT_ENABLED=' "$ENVF")] worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
echo "$(date -Is) restore-end"
RESTORE
}

unit_svc() { # unit_svc <name> <desc> <exec>
  printf '[Unit]\nDescription=%s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nExecStart=%s\n' "$2" "$3"
}
unit_tm() { # unit_tm <name> <desc> <oncalendar>
  printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30\nPersistent=true\nUnit=%s.service\n' "$2" "$3" "$1"
}

MODE=${1:-}
case "$MODE" in
--selftest)
  # 还原件必须自己过语法与三条行为断言；过不了就拒绝安装，别把"看着像"的代码往生产上放。
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  stop_body    > "$T/stop.sh"; restore_body > "$T/restore.sh"
  bash -n "$T/stop.sh"    && echo "  OK   stop.sh 语法过"    || { echo "  WRONG stop.sh 语法不过"; exit 1; }
  bash -n "$T/restore.sh" && echo "  OK   restore.sh 语法过" || { echo "  WRONG restore.sh 语法不过"; exit 1; }
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"; : > "$T/log"
  R114_ENVF="$T/.env" R114_LOG="$T/log" bash "$T/stop.sh"; rc=$?
  grep -q 'stop-skipped\|stop-dryrun' "$T/log" || { echo "  WRONG 关阀脚本既没按时钟拒绝也没走 DRY：闸门不可信"; cat "$T/log"; exit 1; }
  echo "  OK   关阀脚本现在这时刻拒绝（日志：$(grep -o 'stop-[a-z]*' "$T/log" | tail -1)），且阀门没被动过：$(cat "$T/.env")"
  grep -qx 'COLLECT_ENABLED=true' "$T/.env" || { echo "  WRONG 非 21/22 点却改了阀门 —— 时钟闸门失效"; exit 1; }
  R114_ENVF="$T/.env" R114_LOG="$T/log" R114_DRY=1 bash "$T/stop.sh"
  # 15:0x 自测第一次跑出来的真相：时钟闸门在 DRY 判断**之前**，所以非 21/22 点连 `--dry` 都到不了
  # （`stop-dryrun` 打不出来）。我原来断言它该打出来——那是尺写错，不是脚本错。
  # 更强的性质是：**任何模式在非关阀时刻都会拒绝，而且绝不写阀门**。
  grep -q 'stop-skipped' "$T/log" && echo "  OK   非 21/22 点连 R114_DRY=1 也被时钟闸门挡在 sed 之前（打的是 stop-skipped）" \
    || { echo "  WRONG 非关阀时刻没拒绝"; cat "$T/log"; exit 1; }
  echo "  INFO 关阀脚本的 DRY 分支只在 21/22 点可达（时钟闸门在前）——那一支要留到真机上验，这里不算验过"
  R114_ENVF="$T/.env" R114_LOG="$T/log" R114_DRY=1 bash "$T/restore.sh"
  grep -q 'restore-dryrun' "$T/log" && echo "  OK   恢复脚本 DRY 分支可跑（它才是保命的那一半）" || { echo "  WRONG restore-dryrun 没出现"; exit 1; }
  grep -qx 'COLLECT_ENABLED=true' "$T/.env" && echo "  OK   自测结束后阀门仍是 true" || { echo "  WRONG 自测把阀门改了"; exit 1; }
  echo 'SELFTEST_OK（本模式不碰 /opt、不碰 systemd）'
  ;;
--install)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$0" --selftest || { echo "REFUSE 还原件没通过自测，不装"; exit 1; }
  mkdir -p "$BIN"
  stop_body > "$BIN/r114-stop-realtime.sh"; chmod 700 "$BIN/r114-stop-realtime.sh"
  restore_body > "$BIN/r114-restore-realtime.sh"; chmod 700 "$BIN/r114-restore-realtime.sh"
  unit_svc geohot-r114-stop "GEOHOT round-114 close realtime intake (21:00)" "/bin/bash $BIN/r114-stop-realtime.sh" > "$SYS/geohot-r114-stop.service"
  unit_tm geohot-r114-stop "GEOHOT round-114 night window stop timer (21:00)" "*-*-* 21:00:00" > "$SYS/geohot-r114-stop.timer"
  unit_svc geohot-r114-restore "GEOHOT round-114 restore realtime (05:30)" "/bin/bash $BIN/r114-restore-realtime.sh" > "$SYS/geohot-r114-restore.service"
  unit_tm geohot-r114-restore "GEOHOT round-114 night window restore timer (05:30)" "*-*-* 05:30:00" > "$SYS/geohot-r114-restore.timer"
  systemctl daemon-reload
  for t in geohot-r114-stop.timer geohot-r114-restore.timer; do
    systemctl list-timers --all >/dev/null 2>&1
    systemd-analyze calendar "$(grep -oP '(?<=OnCalendar=).*' "$SYS/$t")" | head -2
    # enable 成功≠OnCalendar 合法（装过一遍才懂）：这里逐条验表达式
    systemd-analyze calendar -- --property=OnCalendar --value "$SYS/$t" 2>/dev/null | head -1 || true
  done
  echo "INSTALLED（未 enable —— --install 从不 arm；要今晚就跑 --arm）"
  ;;
--arm)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  [ -f "$SYS/geohot-r114-restore.timer" ] || { echo "REFUSE 恢复那半没装，绝不允许只装关阀那半"; exit 1; }
  systemctl enable --now geohot-r114-stop.timer geohot-r114-restore.timer
  systemctl list-timers 'geohot-r114-*' --no-pager | head -4
  echo "ARMED：今晚 21:00 关阀、明晨 05:30 恢复；反悔就 $0 --disarm"
  ;;
--disarm)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
  echo "DISARMED；阀门与 worker 由本脚本之外的机制决定（当前 $(grep -E '^COLLECT_ENABLED=' "$ENVF" 2>/dev/null)）"
  ;;
*) echo "用法：--selftest | --install | --arm | --disarm"; exit 1;; esac
