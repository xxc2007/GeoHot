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
# Guards: (1) a clock window -- only the 21:xx/22:xx elapse may close the valve unless an
#   operator names R114_FORCE=1. **Read that second half carefully: FORCE is exactly how
#   `install-long-window.sh --start` calls this script**, so this clock guard does NOT protect
#   against a boot-time replay of the Persistent nightly opener. That hole is closed one level up,
#   by `night_ok` inside `--start` (2026-10-18 22:1x adversarial BLOCKER: a 03:00 or 10:00 boot
#   replays the missed 21:00 fire, FORCE-bypasses this guard, and can hold realtime off for the
#   rest of the day -- bounded only by the 10-24 deadline, which is not a daytime bound).
#  (2) refuse-and-revert if the valve/worker do not come back as intended, so a failed stop leaves the site ON.
set -uo pipefail
LOG=${R114_LOG:-/var/log/geohot-r114-window.log}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
# 旗标目录可换：自测必须能把它指到自己的临时目录里。2026-10-18 的教训是——**桩掉 touch 不等于桩掉 `> /etc/...`**，
# 只要路径写死，一次带 R114_FORCE 泄漏的自测就能真的重写开窗时刻、把窗口预算重置。
FLAGD=${R114_FLAG_DIR:-/etc/geohot}
GATEF=${R115_GATE_FILE:-/run/geohot-r115-gate}
exec >> "$LOG" 2>&1
echo "$(date -Is) stop-begin"
H=$(date +%H)
if [ "${R114_FORCE:-0}" = 1 ]; then
  # 操作者点名要"现在就停"（16:5x 站长把话改成"先把实时更新直接停了"）。时钟闸门本来是为
  # Persistent 定时器在开机时补跑而设的，不是给人工动作设的，所以这条分支绕开它——但绕开的是"几点"，
  # 不是下面那道"停完必须能证明恢复得了"的闸门：那道一道都不许绕。
  echo "$(date -Is) stop-forced hour=$H by operator (clock guard bypassed, revert gate still armed)"
elif case "$H" in 21|22) true ;; *) false ;; esac; then : ; else
  echo "$(date -Is) stop-skipped hour=$H -- closing the valve is only legal at 21:xx-22:xx (or with R114_FORCE=1)"
  exit 0
fi
if [ "${R114_DRY:-0}" = 1 ]; then
  echo "$(date -Is) stop-dryrun would: COLLECT_ENABLED=false + restart geohot-worker + stop geohot-archive.timer"
  exit 0
fi
# r115 读者闸门可能正按着 geohot-worker（5xx 触发后的 30 分钟冷却）。那一刻两件事都不能照旧做：
#   ① 不能 restart——那会把闸门刚停的单元又拉起来，两个自动化抢同一个 worker；
#   ② 不能拿"worker 必须 active"当关阀成功的判据——2026-10-18 20:53 那次就是这么把一次**正常**的收窗
#      判成半停、回滚成开阀（restore-FAILED），于是当晚 21:00 那扇再也开不起来。
# 闸门按着期间"worker 是停的"就是预期状态：它起回时读到的已经是 false 了。
# **但"旗标在"不等于"还被按着"**：闸门释放时会 `rm` 掉它，可如果闸门自己没跑（定时器被停、nginx 日期漂了），
# 一份过期的旗标会永远留在那儿。所以只认还没到点的解除时刻（2026-10-18 22:1x 对抗代理 M4）。
GATE_UNTIL=$(cut -d' ' -f1 "$GATEF" 2>/dev/null || echo '')
case "$GATE_UNTIL" in ''|*[!0-9]*) GATE_UNTIL=0 ;; esac
HELD=0; [ "$GATE_UNTIL" -gt "$(date +%s)" ] && HELD=1
sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=false/' "$ENVF"
if [ "$HELD" = 1 ]; then
  echo "$(date -Is) stop-worker-held 读者闸门正按着 worker（解除时刻 $(date -d "@$GATE_UNTIL" '+%F %T' 2>/dev/null || echo "$GATE_UNTIL")）——跳过 restart，等它自己起回"
else
  systemctl restart geohot-worker
fi
systemctl stop geohot-archive.timer
sleep 20
W=$(systemctl is-active geohot-worker)
if ! grep -qx 'COLLECT_ENABLED=false' "$ENVF" || { [ "$W" != active ] && [ "$HELD" != 1 ]; }; then
  echo "$(date -Is) stop-FAILED -> reverting to ON (a half-stopped window is worse than no window)"
  sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=true/' "$ENVF"
  # 回滚也一样不能跟读者闸门抢 worker（①那条纪律不因失败分支就作废）：被按着时留给它自己起回。
  if [ "$HELD" = 1 ]; then
    echo "$(date -Is) revert-worker-held 阀门已改回 true；worker 仍由读者闸门按着（解除时刻 $GATE_UNTIL），不 restart"
  else
    systemctl restart geohot-worker
  fi
  systemctl start geohot-archive.timer
  exit 1
fi
touch "$FLAGD/r114-stop.done.$(date +%F)"
# 旗标名字里带日期是 114 轮的坑（#275）：窗口 21:00→05:30 天生跨午夜，第二天早上按
# $(date +%F) 去找"今天那份"就找不到 ⇒ 靠它兜底的机制会静默熄火。稳定名字留一份，
# 内容是哪一次开的窗口——读的人不必再做日期算术。
date -Is > "$FLAGD/r114-stop.done"
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
FLAGD=${R114_FLAG_DIR:-/etc/geohot}
GATEF=${R115_GATE_FILE:-/run/geohot-r115-gate}
exec >> "$LOG" 2>&1
echo "$(date -Is) restore-begin"
if [ "${R114_DRY:-0}" = 1 ]; then
  echo "$(date -Is) restore-dryrun valve=$(grep -E '^COLLECT_ENABLED=' "$ENVF") worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
  exit 0
fi
# 与关阀那一半同一把互锁（见 stop_body 的注释）：r115 闸门按着 worker 期间，
#   ① 不去 restart（两个自动化抢一个单元，20:53 那次就是 restart 作业被 cancel、worker 卡在 deactivating 六十秒）；
#   ② 不把"worker 必须 active"当恢复成功的判据——那时 worker 停着是**读者优先**的正常状态。
# 但也不能把话说圆：阀门与归档定时器都归位了，采集要等闸门到点起回时才真正恢复，所以日志必须写清解除时刻。
# 与关阀那一半同一个谓词（两边不一致已经错过一次：零字节旗标一边算 HELD、一边不算）。
# **"旗标在" ≠ "还被按着"**——闸门释放时本该 `rm` 掉它，可它自己没跑（定时器被停、nginx 日期漂了）就会留一份过期的在那儿。
# 拿"非空"当 HELD ⇒ restore 永久跳过 restart，还照样判成功、照样 disable 掉 restore/heal ——
# 那时"恢复成功"这句话的真实含义是"不采集"，而 worker 一直是停的（2026-10-18 22:1x 对抗代理 M4）。
GATE_UNTIL=$(cut -d' ' -f1 "$GATEF" 2>/dev/null || echo '')
case "$GATE_UNTIL" in ''|*[!0-9]*) GATE_UNTIL=0 ;; esac
HELD=0; [ "$GATE_UNTIL" -gt "$(date +%s)" ] && HELD=1
sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=true/' "$ENVF"
if [ "$HELD" = 1 ]; then
  echo "$(date -Is) restore-worker-held 读者闸门按着 worker（解除时刻 $(date -d "@$GATE_UNTIL" '+%F %T' 2>/dev/null || echo "$GATE_UNTIL")）——跳过 restart；到点它起回时读到的就是 true"
else
  systemctl restart geohot-worker
fi
systemctl reset-failed geohot-archive.service 2>/dev/null
systemctl start geohot-archive.timer
ok=0
for _ in 1 2 3 4 5 6; do
  sleep 10
  W=$(systemctl is-active geohot-worker)
  if grep -qx 'COLLECT_ENABLED=true' "$ENVF" && systemctl is-active --quiet geohot-archive.timer \
     && { [ "$W" = active ] || [ "$HELD" = 1 ]; }; then ok=1; break; fi
  echo "$(date -Is) restore-retrying worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
done
if [ "$ok" != 1 ]; then
  # 这句原来声称还留着一枚 heal 定时器兜底——**机上根本没有那枚单元**（22:5x 现读：heal 与 verify 都不存在），
  # 于是它把"还有一条重试的路"说给读者听。真正的重试者是哨兵：它每 10 分钟一拍，读到 RESTORE 就再打一枪。
  # （注意：这句注释本身就在正文里，所以别再写回那串字面量——自测正是拿它当拒绝条件。）
  echo "$(date -Is) restore-FAILED valve=$(grep -E '^COLLECT_ENABLED=' "$ENVF") worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer) -- 哨兵保留、下一拍（≤10 分钟）会再试；机上没有 heal 定时器，别等它"
  exit 1
fi
STOPPED_AT=$(cat "$FLAGD/r114-stop.done" 2>/dev/null || echo 无)
# 读的是**不带日期**的那份：05:30 那一刻 `$(date +%F)` 已经是第二天，按日期名去找必然读成"无"，
# 于是这次窗口在日志里看起来像"从来没关过阀"（#275 的原形）。
echo "$(date -Is) restore-window stopped_at=$STOPPED_AT"
touch "$FLAGD/r114-restore.done.$(date +%F)"
date -Is > "$FLAGD/r114-restore.done"
systemctl disable --now geohot-r114-restore.timer 2>/dev/null
systemctl disable --now geohot-r114-refresh.timer 2>/dev/null
systemctl disable --now geohot-r114-heal.timer 2>/dev/null
# 不复位 verify（#269）：恢复之后正该自动验一次；过去这一行把 05:50 那把复验定时器一起 disable 掉了，
# 于是"复位成功"这件事再也没有独立的证据。heal 只在恢复失败时才需要留着（上面 FAILED 分支那句）。
systemctl is-enabled geohot-r114-verify.timer 2>/dev/null | sed 's/^/verify_timer_enabled=/'
echo "$(date -Is) restored [$(grep -E '^COLLECT_ENABLED=' "$ENVF")] worker=$(systemctl is-active geohot-worker) archive_timer=$(systemctl is-active geohot-archive.timer)"
echo "$(date -Is) restore-end"
RESTORE
}

unit_svc() { # unit_svc <name> <desc> <exec>
  printf '[Unit]\nDescription=%s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nExecStart=%s\n' "$2" "$3"
}
unit_tm() { # unit_tm <name> <desc> <oncalendar>
  # [Install] 不是装饰：15:0x 机上 --install 之后 `is-enabled` 打的是 **static**，
  # 没有 WantedBy 的单元 enable 会直接失败 ⇒ --arm 那一步会断。缺它就叫"半装"。
  printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30\nPersistent=true\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$2" "$3" "$1"
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
  # 自测不许依赖墙上时钟，也不许有能力碰生产（2026-10-18 21:22 的实锤事故：这条断言原本写成"非 21/22 点应当拒绝"，
  # 而 --selftest 恰好在 21:22 被调用 ⇒ 它把关阀脚本**真跑了一遍**：停了归档定时器、还往 /etc 写了关阀旗标。
  # 一处自测能改生产，比脚本本身有 bug 更糟。）两道修：① 时刻用桩给定 ⇒ 测试与钟点无关；
  # ② PATH 上的 systemctl／touch 换成记账桩 ⇒ 哪天又走错分支，也碰不到 systemd 和 /etc。
  mkdir -p "$T/bin"; : > "$T/systemctl.calls"
  cat > "$T/bin/systemctl" <<'EOS'
#!/bin/sh
case "$1" in is-active|is-enabled) echo active ;; esac
printf '%s\n' "$*" >> "${R114_STUB_LOG:-/dev/null}"
exit 0
EOS
  cat > "$T/bin/touch" <<'EOS'
#!/bin/sh
printf 'touch %s\n' "$*" >> "${R114_STUB_LOG:-/dev/null}"
exit 0
EOS
  cat > "$T/bin/date" <<'EOS'
#!/bin/sh
if [ "$1" = "+%H" ] && [ -n "${R114_FAKE_HOUR:-}" ]; then printf '%s\n' "$R114_FAKE_HOUR"; exit 0; fi
exec /bin/date "$@"
EOS
  chmod 755 "$T/bin/systemctl" "$T/bin/touch" "$T/bin/date"
  # run_as 必须把"能绕开桩"的环境变量清干净。2026-10-18 22:1x 对抗代理打中的 BLOCKER：
  # 只换 PATH 挡不住 `date -Is > /etc/geohot/r114-stop.done` 这种**重定向写**——桩掉 touch 不等于桩掉 >。
  # 而操作者 shell 里 export 过的 R114_FORCE 会一路漂进自测（我今天整天用的就是这个拼写），
  # 于是"假 03 点必须拒绝"这条断言的前提直接被 FORCE 废掉，写完真实旗标之后才在"零调用"那一步红。
  # ⇒ 两件事一起做：① `-u` 掉 FORCE/DRY；② 把旗标目录与闸门旗标都指到 $T 里，**结构上**碰不到 /etc 与 /run。
  run_as() { env -u R114_FORCE -u R114_DRY R114_FAKE_HOUR="$1" R114_STUB_LOG="$T/systemctl.calls" \
    PATH="$T/bin:$PATH" R114_ENVF="$T/.env" R114_LOG="$T/log" R114_FLAG_DIR="$T/flags" R115_GATE_FILE="$T/gate" "${@:2}"; }
  mkdir -p "$T/flags"
  : > "$T/systemctl.calls"
  run_as 03 bash "$T/stop.sh"; rc=$?
  grep -q 'stop-skipped' "$T/log" || { echo "  WRONG 假时刻 03 点却没按时钟拒绝（闸门不可信）"; cat "$T/log"; exit 1; }
  grep -qx 'COLLECT_ENABLED=true' "$T/.env" || { echo "  WRONG 非关阀时刻却改了阀门"; exit 1; }
  [ ! -s "$T/systemctl.calls" ] && echo "  OK   03 点这一枪：拒绝、不写阀、一次 systemctl／touch 都没调" \
    || { echo "  WRONG 非关阀时刻仍动了系统：$(cat "$T/systemctl.calls")"; exit 1; }
  : > "$T/systemctl.calls"
  run_as 21 R114_DRY=1 bash "$T/stop.sh"
  grep -q 'stop-dryrun' "$T/log" || { echo "  WRONG 21 点的 DRY 分支没到（时钟闸门与 DRY 的先后又漂了）"; cat "$T/log"; exit 1; }
  [ ! -s "$T/systemctl.calls" ] && echo "  OK   21 点 + R114_DRY=1：进 DRY 分支，仍然一次都没调 systemctl／touch（DRY 在 sed 之前）" \
    || { echo "  WRONG DRY 分支竟动了系统"; cat "$T/systemctl.calls"; exit 1; }
  # "零调用"这类断言最容易变成永远绿的摆设（桩根本没生效也会零调用）。拿桩自己作证：调它一次，账上必须多一行。
  : > "$T/systemctl.calls"
  R114_STUB_LOG="$T/systemctl.calls" PATH="$T/bin:$PATH" systemctl restart geohot-worker >/dev/null 2>&1
  [ -s "$T/systemctl.calls" ] && echo "  OK   桩会被记账（上面那两条'零调用'是真的零调用，不是桩没生效）" \
    || { echo "  WRONG 桩不记账 ⇒ '一次 systemctl 都没调'是永远绿的假断言"; exit 1; }
  # —— 以下三条打的是 22:1x 对抗代理的 B2/M4：重定向写、FORCE 泄漏、HELD 只看"旗标在不在"。
  REAL_FLAG_MTIME=$(stat -c %Y /etc/geohot/r114-stop.done 2>/dev/null || echo none)
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"; : > "$T/log"
  R114_FORCE=1 run_as 03 bash "$T/stop.sh"; rc=$?
  grep -q 'stop-skipped' "$T/log" || { echo "  WRONG 操作者 shell 里 export 了 R114_FORCE=1，自测就按时钟放行 ⇒ run_as 没把它清掉（这一条会真写生产旗标）"; cat "$T/log"; exit 1; }
  [ -e "$T/flags/r114-stop.done" ] && { echo "  WRONG FORCE 泄漏那一次仍把旗标写进了旗标目录"; exit 1; }
  [ "$rc" = 0 ] && echo "  OK   R114_FORCE 漂进自测也会被 run_as 剥掉：假 03 点仍然拒绝，且旗标一个没写"
  # HELD 的语义：只认"还没到点的解除时刻"。旗标在而时刻已过 ⇒ 闸门没跑（或忘了清），这时必须照旧 restart。
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"; : > "$T/log"; : > "$T/systemctl.calls"
  printf '%s 1\n' "$(( $(date +%s) + 1800 ))" > "$T/gate"
  run_as 21 bash "$T/stop.sh"
  grep -q 'stop-worker-held' "$T/log" && ! grep -q 'restart geohot-worker' "$T/systemctl.calls" \
    && echo "  OK   闸门未到点（+30 分）：关阀跳过 restart（两个自动化不抢同一个 worker）" \
    || { echo "  WRONG 未到点的旗标没被认出来，或仍然 restart 了：$(cat "$T/systemctl.calls")"; cat "$T/log"; exit 1; }
  : > "$T/log"; : > "$T/systemctl.calls"
  printf '%s 1\n' "$(( $(date +%s) - 60 ))" > "$T/gate"
  run_as 21 bash "$T/stop.sh"
  grep -q 'restart geohot-worker' "$T/systemctl.calls" \
    && echo "  OK   旗标已过期（闸门没跑成）：不再当 HELD，照旧 restart——'恢复成功'不会悄悄变成'不采集'" \
    || { echo "  WRONG 过期旗标仍被当成正被按着 ⇒ restore 那半边会永久跳过 restart 还判成功（M4）"; cat "$T/log"; exit 1; }
  rm -f "$T/gate"
  # 全路径演练：合法时刻、不 DRY，所有副作用（阀门、旗标、systemctl、touch）都必须落在 $T 里。
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"; : > "$T/log"; : > "$T/systemctl.calls"
  run_as 22 bash "$T/stop.sh"
  grep -qx 'COLLECT_ENABLED=false' "$T/.env" || { echo "  WRONG 全路径演练没走到写阀那一步"; cat "$T/log"; exit 1; }
  [ -s "$T/flags/r114-stop.done" ] || { echo "  WRONG 旗标没写进临时目录——说明 FLAGD 没用上，真实 /etc 可能挨了一枪"; exit 1; }
  AFTER_FLAG_MTIME=$(stat -c %Y /etc/geohot/r114-stop.done 2>/dev/null || echo none)
  [ "$REAL_FLAG_MTIME" = "$AFTER_FLAG_MTIME" ] \
    && echo "  OK   全路径演练：阀门/旗标/systemctl 全在 $T 里，生产旗标 mtime 前后一致（[$REAL_FLAG_MTIME]）" \
    || { echo "  WRONG 自测把生产旗标改了（$REAL_FLAG_MTIME → $AFTER_FLAG_MTIME）——立刻停，别装"; exit 1; }
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"
  printf 'COLLECT_ENABLED=true\n' > "$T/.env"; : > "$T/log"
  env -u R114_FORCE R114_DRY=1 R114_FAKE_HOUR=22 R114_STUB_LOG="$T/systemctl.calls" PATH="$T/bin:$PATH" \
    R114_ENVF="$T/.env" R114_LOG="$T/log" R114_FLAG_DIR="$T/flags" R115_GATE_FILE="$T/gate" bash "$T/restore.sh"
  grep -q 'restore-dryrun' "$T/log" && echo "  OK   恢复脚本 DRY 分支可跑（它才是保命的那一半）" || { echo "  WRONG restore-dryrun 没出现"; exit 1; }
  grep -qx 'COLLECT_ENABLED=true' "$T/.env" && echo "  OK   自测结束后阀门仍是 true" || { echo "  WRONG 自测把阀门改了"; exit 1; }
  # 15:0x 机上装完才暴露的那一类：`is-enabled` 打 static ⇒ enable 会失败 ⇒ --arm 断在最后一步。
  # 现在本地就把生成的 timer 拿出来查 [Install]，别让"半装"再到机上才发现。
  unit_tm geohot-r114-stop "d" "*-*-* 21:00:00" > "$T/stop.timer"
  grep -q 'WantedBy=timers.target' "$T/stop.timer" && echo "  OK   生成的 timer 带 [Install] WantedBy=timers.target（enable 得动）" \
    || { echo "  WRONG timer 没有 [Install] 段 ⇒ --arm 的 systemctl enable 必然失败"; exit 1; }
  grep -q 'Persistent=true' "$T/stop.timer" && echo "  OK   Persistent=true（恢复那半靠它兜住错过的时刻）" || { echo "  WRONG 丢了 Persistent"; exit 1; }
  # —— #275 / #269 两条：旗标要跨得过午夜，恢复那半不许杀掉自己的复验。
  # 这两条是**文本级**断言（自测不碰 /etc，也不碰 systemd），它们防的是"改回去"，不是"运行时一定对"。
  # 路径参数化成 FLAGD 之后，断言两种写法都认：只认字面 /etc 的那条会因为我自己的参数化**假红**（22:3x 真红过一次）。
  # 一律用 `-F`：上一条带 `"?` 的 ERE 在实测里连 `/etc/geohot` 那一支都匹配不到（0 命中），
  # 与其跟正则的引号/可选量较劲，不如把断言写成定长串——**它拒绝的形状（只剩带日期的名字）当场验证过**。
  { grep -qF 'date -Is > "$FLAGD/r114-stop.done"' "$T/stop.sh" || grep -qF 'date -Is > /etc/geohot/r114-stop.done' "$T/stop.sh"; } \
    && echo "  OK   关阀写了不带日期的那份旗标（跨午夜还读得到）" \
    || { echo "  WRONG 关阀旗标只有带日期的名字 —— 05:30 读它就是'从没关过阀'"; exit 1; }
  grep -qF 'FLAGD=${R114_FLAG_DIR:-/etc/geohot}' "$T/stop.sh" && grep -qF 'FLAGD=${R114_FLAG_DIR:-/etc/geohot}' "$T/restore.sh" \
    && echo "  OK   两半的旗标目录都可换、默认仍是 /etc/geohot（自测能指进临时目录，生产行为不变）" \
    || { echo "  WRONG FLAGD 没定义或默认值丢了——自测就会打真 /etc"; exit 1; }
  { grep -qF 'cat "$FLAGD/r114-stop.done"' "$T/restore.sh" || grep -qF 'cat /etc/geohot/r114-stop.done' "$T/restore.sh"; } \
    && echo "  OK   恢复那半真的会去读它（不是写给人看的装饰品）" || { echo "  WRONG 没人读那份旗标"; exit 1; }
  if grep -q 'disable --now geohot-r114-verify' "$T/restore.sh"; then
    echo "  WRONG 恢复又去 disable 复验定时器了（#269：05:50 那把尺会被静默拔掉）"; exit 1
  else echo "  OK   恢复不碰 verify 定时器"; fi
  # 失败语要说真话：机上没有 heal 定时器（22:5x 现读，heal 与 verify 都不存在），
  # 那句"leaving heal armed"会让人以为还有第二条重试的路——真正的重试者是每 10 分钟一拍的哨兵。
  grep -qF 'leaving geohot-r114-heal.timer armed' "$T/restore.sh" \
    && { echo "  WRONG 失败语还在说有 heal 定时器兜底，而机上没有那枚单元"; exit 1; } \
    || grep -qF '下一拍（≤10 分钟）会再试' "$T/restore.sh" \
    && echo "  OK   恢复失败语点的是真正的重试者（哨兵下一拍），不再提不存在的 heal 定时器" \
    || { echo "  WRONG 失败语既没提 heal 也没提哨兵——别让人猜"; exit 1; }
  # r115 读者闸门与这两半的互锁（2026-10-18 20:53 实测的代价：闸门按着 worker 期间，
  # 关阀/恢复那句"worker 必须 active"恒假 ⇒ 一次正常的收窗被判成半停并回滚，当晚 21:00 那扇就再也没开起来）。
  grep -q 'stop-worker-held' "$T/stop.sh" && grep -q 'HELD=0' "$T/stop.sh" \
    && echo "  OK   关阀认得闸门：按着期间不 restart、也不拿 worker=active 当成功条件" \
    || { echo "  WRONG 关阀会跟读者闸门抢同一个 worker"; exit 1; }
  if grep -q '! systemctl is-active --quiet geohot-worker' "$T/stop.sh"; then
    echo "  WRONG 那句恒假断言还在（闸门冷却期内必然为假，会把正常收窗判成失败）"; exit 1
  else echo "  OK   旧的 worker=active 硬断言已从关阀那半摘掉"; fi
  grep -q 'restore-worker-held' "$T/restore.sh" && grep -q 'GATE_UNTIL=' "$T/restore.sh" \
    && echo "  OK   恢复那半同样让路，并把闸门的解除时刻打进日志（不把'恢复了'说成'已在采集'）" \
    || { echo "  WRONG 恢复不认识闸门"; exit 1; }
  # 证这条断言真的有电：故意造一份"退回旧写法"的副本，它必须判红。
  sed 's|systemctl disable --now geohot-r114-heal.timer|systemctl disable --now geohot-r114-verify.timer|' "$T/restore.sh" > "$T/restore.broken.sh"
  if grep -q 'disable --now geohot-r114-verify' "$T/restore.broken.sh"; then
    echo "  OK   EXPECTED_RED：把旧写法塞回去，这条断言确实会红（说明它不是永远绿的摆设）"
  else echo "  WRONG 这条断言抓不到已知的坏写法 —— 尺坏了"; exit 1; fi
  echo 'SELFTEST_OK（本模式不碰 /opt、不碰 systemd）'
  ;;
--bodies-only)
  # 只重落关阀/恢复那两份函数体，**不动任何单元、不 enable**。
  # 为什么单开这一档：--install 会顺手重写 geohot-r114-stop.timer(21:00) 与 geohot-r114-restore.timer(05:30)——
  # 本轮的姿势是"连续窗口"，那两枚是**故意** disable 的（05:30 那把会在档案正要开跑时截断窗口）。
  # 为了换两个函数体去惊动它们，就是把一次小修变成一次政策变更。
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$0" --selftest >/dev/null || { echo "REFUSE 自测不过，不落盘"; exit 1; }
  mkdir -p "$BIN"
  V_BEFORE=$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")
  stop_body > "$BIN/r114-stop-realtime.sh.tmp" && mv "$BIN/r114-stop-realtime.sh.tmp" "$BIN/r114-stop-realtime.sh"
  restore_body > "$BIN/r114-restore-realtime.sh.tmp" && mv "$BIN/r114-restore-realtime.sh.tmp" "$BIN/r114-restore-realtime.sh"
  chmod 700 "$BIN/r114-stop-realtime.sh" "$BIN/r114-restore-realtime.sh"
  chown root:root "$BIN/r114-stop-realtime.sh" "$BIN/r114-restore-realtime.sh"
  bash -n "$BIN/r114-stop-realtime.sh" && bash -n "$BIN/r114-restore-realtime.sh" && echo "  OK   两份落盘的都语法过" || { echo "  WRONG 落盘的语法不过"; exit 1; }
  R114_DRY=1 bash "$BIN/r114-stop-realtime.sh"; SC=$?
  R114_DRY=1 bash "$BIN/r114-restore-realtime.sh"; RC2=$?
  [ "$SC" = 0 ] && [ "$RC2" = 0 ] && echo "  OK   两份都能以 R114_DRY=1 空跑（rc=0）" || { echo "  WRONG 空跑就失败：真跑更不敢信 stop=$SC restore=$RC2"; exit 1; }
  V_AFTER=$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")
  [ "$V_BEFORE" = "$V_AFTER" ] && echo "  OK   空跑之后阀门原样（$V_AFTER）——DRY 分支真的没写盘" \
    || { echo "  WRONG DRY 把阀门改了：$V_BEFORE → $V_AFTER"; exit 1; }
  printf '  现值 stop=%s restore=%s 阀门=%s\n' "$(sha256sum "$BIN/r114-stop-realtime.sh" | cut -c1-16)" \
    "$(sha256sum "$BIN/r114-restore-realtime.sh" | cut -c1-16)" "$(cut -d= -f2 <<<"$V_AFTER")"
  echo BODIES_ONLY_DONE
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
