#!/bin/bash
# 第 115 轮：把"停掉实时更新去排历史"做成机器自己会结束的窗口。
#
# 为什么要停：16:53 现读存量是 档案待判 14,691 ∶ 实时待判 1,409，而近 60 分钟判完 178 条里 **0 条属于一到九月**
# （`pgboss.job.state='completed'` join `articles.timeline_at` 现读）。实时带一直在吃那 4 个内存槽，
# 关进口是当下唯一能让档案带拿到全部槽位的动作——份额与门槛都不用改。
#
# 为什么不能手停就走：会话会结束，站长不会半夜来问"排完了没有"。所以这里装一把每 10 分钟自问的排空哨兵，
# 它自己判五件事：排空了→恢复；读者的路红了→立刻恢复（读者的命优先于历史）；内存撑不住→恢复；
# 存量三小时一点不降（静默停摆）→恢复；量具连续读不到（看不见就没资格替站长按着进口）→恢复；到最迟期限→无论如何恢复。
# 这五条排在"读不到存量"这条**之前**——顺序反了的话，量具一坏就把另外四条保命规则一起屏蔽掉（17:34—17:36 实测漏过 5xx）。
# 期限为什么是 2026-10-31 06:00（10-19 01:4x 三次改判）：重开后 110 分钟合计 16,745→16,694，只净减 51 条（−28/时）；
# 01:30 的 −49/30 分钟（−98/时）是判定爆发，01:40 被 +23 的进口打回。S=119 片按 1.58 片/时约 75 小时扫完，期间进口抵消判定；
# 扫完后合计 ≈14,400 按 −116/时需 ≈124 小时（10-27 夜），翻译尾 1,541 条按 24～43/时再 1.5～2.7 天 ⇒ 10-29～10-30，10-31 兜底。
# 哨兵排空仍会提前收工；每次改期限只动机上两枚单元的 Environment 与这里，不动判据、份额与模型池。
# 三件事共用一份判据文件（$BIN/r114-drain-decide.sh）——**自测跑的就是生产要 source 的那一份**，
# 不复制第二份判据，免得"测的是一份、装的是一份"。
#
# 用法（都要 root）：
#   bash install-long-window.sh --selftest              # 不碰系统，只验判据与单元模板
#   bash install-long-window.sh --start                 # 先装并 enable 哨兵，再关阀（顺序不可反：先有回去的路再出门）
#                                                       # 关阀后再放行归档周期——扫片与出刊只有它会干，夜里正是它干活的时候
#   bash install-long-window.sh --arm-nightly           # 每晚 21:00 自动 --start；白天立刻按住归档周期（115 轮的实测依据见下）
#   bash install-long-window.sh --disarm-nightly        # 撤掉晚间排程，并把归档周期交回日常节律
#   bash install-long-window.sh --refresh               # 窗口开着时改判据：只重落脚本与单元，不碰阀、不 enable
#   bash install-long-window.sh --once                  # 手工跑一轮生产哨兵（同一条代码路径）
#   bash install-long-window.sh --restore               # 手工恢复并拆哨兵
#   bash install-long-window.sh --status                # 现读：阀、哨兵、晚间排程、最近判定
#
# 为什么白天不该开这一扇（115 轮的实测）：17:00 开、17:47 撤，撤窗后读者面仍红（18:00—18:06 是 34/65 请求 5xx），
# 因为关阀只停"新进口"，那 1.6 万条已排队的判定作业与 15 分钟归档周期照跑——阀门不是负载旋钮。
# 真正与 5xx 同段的是 17:30 起跑、跑了 34 分钟没收的那一轮归档周期，加上一波外部深页爬虫
# （单 IP 203.10.99.26 45 分钟 147 次请求），底盘是 7 个空闲 pg 后端各 140 MB ≈ 980 MB > 物理 891 MB ⇒ 页缓存被挤光。
set -uo pipefail

BIN=${GEOHOT_BIN:-/opt/geohot/bin}
SYS=${SYSTEMD_SYS:-/etc/systemd/system}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
LOG=${R114_LOG:-/var/log/geohot-r114-longwindow.log}
WATCH=${R114_WATCH:-$BIN/r114-drain-watch.sh}
DECIDE=${R114_DECIDE:-$BIN/r114-drain-decide.sh}
STOPPER=${R114_STOPPER:-$BIN/r114-stop-realtime.sh}
REVERTER=${R114_REVERTER:-$BIN/r114-restore-realtime.sh}
DL_DEFAULT=$(date -d "2026-10-31 06:00:00" +%s 2>/dev/null || echo 0)
DEADLINE_EPOCH=${R114_DEADLINE_EPOCH:-$DL_DEFAULT}
FLOOR=${R114_FLOOR_AVAIL_MB:-60}
BUDGET=${R114_BUDGET_ERR5XX:-0}
STREAK_N=${R114_LOWMEM_STREAK:-3}
STALL_N=${R114_STALL_STREAK:-18}
BLIND_N=${R114_BLIND_STREAK:-3}
E5WIN=${R114_E5_WINDOW_SEC:-700}
MAXSEC=${R114_MAX_WINDOW_SEC:-34200}
CADENCE=${R114_WATCH_CADENCE:-"*:00/10"}

# night_ok <HH>：这一枪能不能**新开**一扇独占窗口。
# 为什么要在 --start 上再设一道（2026-10-18 22:1x 对抗代理打中的 BLOCKER）：
# 我把每晚开窗那枚 timer 改成了 `Persistent=true`（错过 21:00 就少一整夜，且不留日志），
# 而 systemd 的 Persistent 补跑不看时刻——机器在 03:00 或 10:00 起来时，昨天错过的 21:00 会**立刻补一枪**，
# `--start` 又带着 `R114_FORCE=1` 绕开关阀脚本自己的时钟闸，于是"白天把实时关掉一整天"变成可能，
# 上限只有死期限（10-31 06:00）那么长。17:0x 那一扇实测就是 57 条 5xx／首页 15.3 s。
# ⇒ 界不在死期限，界在"这一枪落在几点"。人工白天要开，明写 `R114_ANY_HOUR=1`，绕路比用脚本麻烦。
night_ok() { case "${1-}" in 21|22|23|00|01|02|03|04|05) return 0 ;; *) return 1 ;; esac; }

decide_body() { cat <<'DECIDE'
# 唯一一份窗口去留判据。只吃数字、不碰世界，所以每个分支都能被夹具走到。
#   $1 剩余待判(档案)  $2 可用内存 MB  $3 近读窗口内本站 5xx  $4 现在(epoch)  $5 最迟期限(epoch)
#   $6 已连续几次低内存（1 次不算——一次抽样不该结束窗口）
#   $7 已连续几次"存量一点没降"（窗口最怕的是静默停摆：门被板凳、worker 卡住，剩下的就是白等到死期限）
#   $8 已连续几次"量具读不到"（存量或读者面 5xx 任一读数失败就 +1：看不见读者的窗口不能开）
#   $9 本次开窗的时刻 epoch（取 /etc/geohot/r114-stop.done 的 mtime；0=不知道就不按上限收口）
#   环境变量：GEOHOT_FLOOR_AVAIL_MB（内存地板，默认 60：114 轮整夜窗口里 availMB 最低也有 139，17:22 现读 86 属正常）
#             GEOHOT_BUDGET_ERR5XX（5xx 预算，默认 0：读者的路一红就撤，历史让位）
#             GEOHOT_LOWMEM_STREAK（低内存要连续几次才撤，默认 3 = 30 分钟）
#             GEOHOT_STALL_STREAK（停摆要连续几次才撤，默认 18 = 3 小时，每 10 分钟一次；判据是"零判完"，存量涨不算停摆）
#             GEOHOT_BLIND_STREAK（看不见要连续几次才撤，默认 3 = 30 分钟：瞎着的哨兵不如开实时）
#             GEOHOT_MAX_WINDOW_SEC（单窗上限，默认 34200 = 9.5 小时：天亮前必须让回实时，不靠另一半天亮定时器）
decide() {
  local left="${1:-0}" avail="${2:-0}" e5="${3:-0}" now="${4:-0}" deadline="${5:-0}" streak="${6:-1}" stalled="${7:-0}" blind="${8:-0}" opened="${9:-0}"
  local floor="${GEOHOT_FLOOR_AVAIL_MB:-60}" budget="${GEOHOT_BUDGET_ERR5XX:-0}" need="${GEOHOT_LOWMEM_STREAK:-3}"
  local stallneed="${GEOHOT_STALL_STREAK:-18}" blindneed="${GEOHOT_BLIND_STREAK:-3}" maxsec="${GEOHOT_MAX_WINDOW_SEC:-34200}"
  # 顺序要紧：所有 RESTORE 保护都先于低内存短暂观察与"读不到存量"的 HOLD。
  # 17:34—17:36 那两条 HOLD|unknown_left 里就藏着 err5xx=30/45 —— 旧写法把 unknown_left 顶在第一行，
  # 量具一坏就把 5xx/低内存/期限三条保命规则一起屏蔽了，这是这类哨兵最危险的失效模式。
  if [ "$e5" -gt "$budget" ]; then echo "RESTORE|reader_5xx=$e5"; return; fi
  if [ "$avail" -lt "$floor" ] && [ "$streak" -ge "$need" ]; then echo "RESTORE|low_mem=${avail}MB streak=$streak"; return; fi
  # 停摆放在期限之前：先恢复实时（站点继续活着），而不是干等到死期限再恢复。
  if [ "$stalled" -ge "$stallneed" ]; then echo "RESTORE|stalled=${stalled}轮_零判完"; return; fi
  if [ "$blind" -ge "$blindneed" ]; then echo "RESTORE|gauge_blind=${blind}轮读不到量具"; return; fi
  # 单窗上限（默认 9.5 小时）：夜里那一扇就算没排空也该在天亮前让回实时，
  # 万一 05:30 那半恢复单元没跑成（它是机器侧的另一条路，不是这里的责任），这条自己会收口。
  if [ "$opened" -gt 0 ] && [ "$maxsec" -gt 0 ] && [ $(( now - opened )) -ge "$maxsec" ]; then
    echo "RESTORE|max_window=$(( (now - opened) / 60 ))min"; return
  fi
  if [ "$deadline" -gt 0 ] && [ "$now" -ge "$deadline" ]; then echo "RESTORE|deadline"; return; fi
  # 低内存尚未攒够连击只延后内存规则；到期或超出单窗上限时仍必须恢复。
  if [ "$avail" -lt "$floor" ]; then echo "HOLD|low_mem=${avail}MB streak=$streak/$need"; return; fi
  # 读不到存量 = -1，绝不能当成"排空了"；但也不能拿它当"继续开"的理由一直压着——blind 那条已经在管它。
  if [ "$left" -le -1 ]; then echo "HOLD|unknown_left"; return; fi
  if [ "$left" -le 0 ]; then echo "RESTORE|drained"; return; fi
  echo "HOLD|left=$left avail=${avail}MB e5=$e5 stalled=$stalled/$stallneed"
}
# 停摆计数：需要**上次的存量**、**上次的计数**、**本次存量**，再加**最近 30 分钟真判完的条数**。
#   $1 上次存量（空=第一轮）  $2 上次计数  $3 本次存量  $4 近 30 分钟判完条数（生产只会传数字或 -1；-1=量具死了，本轮当无证据）
# 为什么要有第 4 个输入（2026-10-18 19:4x 实测）：连续窗口里归档进口照跑（一轮 +15 条），而队列按优先级
# 先消化实时带残留（19:40 现读 233 条 priority 0），那段时间判定腿存量必然只涨不降——近 60 分钟判完 97 条
# 全落在实时带、档案带 0 条。只比存量就会把"正在干活"读成停摆，18 轮（约 22:2x）后自己撤窗、把实时放回来，
# 而"先停实时"正是站长这一次明令的前提。判完条数 >0 是它在干活的硬证据，比存量差直接。
next_stall() {
  local prev="${1-}" cnt="${2-0}" now="${3-}" done_n="${4-}"
  case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
  case "$prev" in ''|*[!0-9]*) echo 0; return ;; esac
  # 本次读不到存量：计数**保持不动**——既不 +1（一次 psql 抖动不该往撤窗走），也不归零（那会掩盖真停摆）。
  case "$now" in ''|*[!0-9]*) echo "$cnt"; return ;; esac
  # 有判完就是没停摆，哪怕存量在涨（进口比排水快的头几个小时正是这种形状）。
  case "$done_n" in ''|*[!0-9]*) : ;; *) if [ "$done_n" -gt 0 ]; then echo 0; return; fi ;; esac
  if [ "$now" -lt "$prev" ]; then echo 0; else echo $(( cnt + 1 )); fi
}
# 低内存计数：哨兵自己不记状态，靠 /run 里那一个数字。抽成函数是为了能被夹具测到（生产跑的与测的是同一份）。
#   $1 上次计数  $2 本次可用 MB  $3 可用 MB 数（坏值一律当 0）  $4 地板
next_streak() {
  local prev="${1:-0}" avail="${2:-0}" floor="${3:-60}"
  case "$prev" in ''|*[!0-9]*) prev=0 ;; esac
  case "$avail" in ''|*[!0-9]*) avail=0 ;; esac
  case "$floor" in ''|*[!0-9]*) floor=60 ;; esac
  if [ "$avail" -lt "$floor" ]; then echo $(( prev + 1 )); else echo 0; fi
}
# "看不见"计数：存量、读者面 5xx、"有没有在干活"三把尺任一读不到合法数字就 +1，全好才归零。
# 为什么要单独一条：17:34—17:36 连续两轮 psql 读空（存量=-1），那时哨兵既不知道排没排空、也不知道读者好不好，
# 却还在说 HOLD —— 一个看不见读者的哨兵没有资格替站长把实时按着。
#   $1 上次计数  $2 合计存量（-1 或非数字=读不到）  $3 近窗 5xx 条数（空或非数字=读不到）
#   $4 近 30 分钟判完条数：**没传第 4 个参数就不参与判断**（夹具与旧调用保持原语义），传了但坏掉（-1/非数字）就算瞎一格
next_blind() {
  local prev="${1-0}" left="${2-}" e5="${3-}" dn="${4-}"
  case "$prev" in ''|*[!0-9]*) prev=0 ;; esac
  case "$left" in ''|*[!0-9]*) echo $(( prev + 1 )); return ;; esac
  if [ "$left" -le -1 ]; then echo $(( prev + 1 )); return; fi
  case "$e5" in ''|*[!0-9]*) echo $(( prev + 1 )); return ;; esac
  # 判据改了口径之后，"有没有在干活"这把尺自己也会死（表没了、列改名、连接超时）。
  # 它死了却不被数进看不见，就会**安静退回旧口径**——那正是这一轮要杀掉的那条误撤窗规则，等于换个门重新进来。
  if [ "$#" -ge 4 ]; then
    case "$dn" in ''|*[!0-9]*) echo $(( prev + 1 )); return ;; esac
    if [ "$dn" -le -1 ]; then echo $(( prev + 1 )); return; fi
  fi
  echo 0
}
# 档案带"饿着"计数——与停摆是两件事：停摆问"这台机还在不在产出"，这条问"回填带连续多少轮一条都没判完"。
#   $1 上次计数  $2 近 30 分钟**档案带**判完条数（-1 或非数字=读不到 → 保持不动，不推进也不清零）
# 为什么只报警、不撤窗：档案带被别的带吃掉槽位时，恢复实时只会把那条带变得更长——正解是份额旋钮，
# 而它自己写着"只有站长能动"（scripts/rebalance-archive-queue.ts:11—16）。所以这条把形状打进日志交人判，不替站长动手。
next_starve() {
  local prev="${1-0}" d="${2-}"
  case "$prev" in ''|*[!0-9]*) prev=0 ;; esac
  case "$d" in ''|*[!0-9]*) echo "$prev"; return ;; esac
  if [ "$d" -le -1 ]; then echo "$prev"; return; fi
  if [ "$d" -gt 0 ]; then echo 0; else echo $(( prev + 1 )); fi
}
# 读者面 5xx 按**时刻**锚，不按"尾读 N 行"：旧尺数的是"今天之内、且落在最后 4000 行里"，而 4000 行覆盖多长
# 会随流量伸缩（17:24 读到 0、17:34 读到 30、17:36 读到 45 那种两义读数就是这么来的）。
# 字段偏移：$4 = "[18/Oct/2026:17:41:27"，日期占 2—12、冒号在 13，所以小时从 **14** 起（用 13 会把小时读成 0，
# 窗口过滤器于是永远数不到东西——17:44 我自己就栽过一次，这条由 selftest 的夹具钉住）。
#   $1 日志  $2 尾读行数  $3 窗口秒  $4 今天前缀(18/Oct/2026)  $5 今晨 epoch  $6 现在 epoch
e5_count() { # $1 日志 $2 tail 行数 $3 窗口秒 $4 今天日期 $5 今天零点 $6 now [$7 昨天日期] [$8 昨天零点]
  # **午夜盲点**（2026-10-19 00:00 真机抓到）：700 秒窗天生跨午夜，而这里只匹配「今天」的日期前缀
  # ⇒ 00:00—00:11 之间窗口被截断成几十秒，样本只有 2 行、读数却是 0（不是 -1，所以 blind 也不会涨）。
  # 修法：把昨天也传进来；每行按它自己那天的零点算 age。`age >= -5` 容忍几秒的时钟前跳（nginx 在请求结束时写日志）。
  tail -n "$2" "$1" 2>/dev/null | awk -v d="$4" -v t0="$5" -v d2="${7:-}" -v t02="${8:-0}" -v now="$6" -v w="$3" '
    { base=0
      if (d2 != "" && index($4, "[" d2 ":")==1) base=t02
      else if (index($4, "[" d ":")==1) base=t0
      else next
      n++; if (first=="") first=substr($4,14,5); last=substr($4,14,5)
      hh=substr($4,14,2)+0; mi=substr($4,17,2)+0; ss=substr($4,20,2)+0
      if (base>0 && substr($9,1,1)=="5" && index($7, "/geohot")>0) {
        age=now-(base+hh*3600+mi*60+ss)
        if (age >= -5 && age <= w) c++
      }
    } END { if (n+0 == 0) print "-1 0 无当日样本"; else print c+0, n+0, first"-"last }'
}
# 只数纯数字：psql 一旦多打一行（.psqlrc 的 \timing 会打 `Time: 3.501 ms`），
# `tail -1 | tr -dc 0-9` 会造出 3501 这种"看着像存量"的假数——宁可读数失败，也不要假数。
digits_only() { case "${1:-}" in ''|*[!0-9]*) echo -1 ;; *) printf '%s' "$1" ;; esac; }
# 读者优先闸门的去留（闸门脚本与 selftest 跑同一份）：
#   $1 近窗 5xx（-1=读不到）  $2 现在 epoch  $3 冷却截止 epoch（0=没有）  $4 本闸门是否承担恢复责任（1/0）
#   $5 worker 现在 active?  $6 预算  $7 闸门是否被 disarmed 旗标按住（1=按住）
# 返回：SKIP_DISARMED / SKIP_BLIND / SKIP_OPERATOR_STOPPED / HELD / TRIP / RELEASE / CONFIRM_RELEASE / IDLE
gate_action() {
  local e5="${1:--1}" now="${2:-0}" until="${3:-0}" we_stopped="${4:-0}" active="$5" budget="${6:-0}" disarmed="${7:-0}"
  # 入参先消毒：非数字一律当"读不到"（-1）或 0。不能让 [ x -le -1 ] 这种整数比较报错把一次判定变成脚本失败。
  case "$e5" in ''|*[!0-9]*) e5=-1 ;; esac
  case "$now" in ''|*[!0-9]*) now=0 ;; esac
  case "$until" in ''|*[!0-9]*) until=0 ;; esac
  case "$we_stopped" in ''|*[!0-9]*) we_stopped=0 ;; esac
  case "$budget" in ''|*[!0-9]*) budget=0 ;; esac
  [ "$disarmed" = 1 ] && { echo SKIP_DISARMED; return; }
  if [ "$e5" -le -1 ]; then echo SKIP_BLIND; return; fi
  if [ "$until" -gt 0 ] && [ "$now" -lt "$until" ]; then echo HELD; return; fi
  if [ "$e5" -gt "$budget" ]; then
    # operator 已经停下的 worker 不归本闸门认领，红指标也不能伪造恢复责任。
    if [ "$we_stopped" != 1 ] && [ "$active" != active ]; then echo SKIP_OPERATOR_STOPPED; else echo TRIP; fi
    return
  fi
  # 只有已记录停止意图、由本闸门承担恢复责任的才可自动恢复；operator 自己停的 worker 不碰。
  if [ "$we_stopped" = 1 ]; then
    if [ "$active" = active ]; then echo CONFIRM_RELEASE; else echo RELEASE; fi
    return
  fi
  echo IDLE
}
DECIDE
}

watch_body() { cat <<'WATCH'
#!/bin/bash
# 每 10 分钟问一次：历史排完了吗？读者的路还顺吗？到期限了吗？
set -uo pipefail
LOG=${R114_LOG:-/var/log/geohot-r114-longwindow.log}
exec >> "$LOG" 2>&1
BIN=${GEOHOT_BIN:-/opt/geohot/bin}
ENVF=${R114_ENVF:-/opt/geohot/app/.env}
DEADLINE_EPOCH=${R114_DEADLINE_EPOCH:-0}
export GEOHOT_FLOOR_AVAIL_MB=${R114_FLOOR_AVAIL_MB:-60}
export GEOHOT_BUDGET_ERR5XX=${R114_BUDGET_ERR5XX:-0}
export GEOHOT_LOWMEM_STREAK=${R114_LOWMEM_STREAK:-3}
export GEOHOT_STALL_STREAK=${R114_STALL_STREAK:-18}
export GEOHOT_BLIND_STREAK=${R114_BLIND_STREAK:-3}
export GEOHOT_MAX_WINDOW_SEC=${R114_MAX_WINDOW_SEC:-34200}
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
# 排空 = 两条腿都空。判定腿只数**没判过的**（processing_state='new'，走 articles_processing_idx，现读 3.5 s）；
# 之前把 analyzed 也算进"没排完"是错的——analyzed 就是"判过了"，那样存量永远不会归零，窗口只能等死期限。
J=$(digits_only "$(PGOPTIONS="-c statement_timeout=30s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM articles a WHERE a.processing_state='new' AND a.timeline_at < '2026-10-01+08'" 2>/dev/null | tail -1)")
T=$(digits_only "$(PGOPTIONS="-c statement_timeout=30s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM publications p JOIN articles a ON a.id=p.article_id LEFT JOIN translations tr ON tr.article_id=p.article_id AND tr.lang='zh' WHERE p.selected AND p.visibility='public' AND p.body_mode='full' AND coalesce(a.language,'')<>'zh' AND p.timeline_at < '2026-10-01+08' AND (tr.article_id IS NULL OR (tr.origin<>'source' AND (tr.revision<a.revision OR NOT tr.complete)))" 2>/dev/null | tail -1)")
[ -n "$J" ] || J=-1
[ -n "$T" ] || T=-1
# 第三个条件：一到九月还有**没扫完的切片**时，"判完了"不等于"回填完了"。
# 17:29 现读 archive_ingest：Jan–Sep 还有 128 片 pending/running（十月那 119 片不算——当月门本来每轮都走）。
# 不算这一项的话，判定腿只要追上进口就会误报"排空"，窗口在半成品上收工。
S=$(digits_only "$(PGOPTIONS="-c statement_timeout=30s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM archive_ingest WHERE month < '2026-10' AND status <> 'done'" 2>/dev/null | tail -1)")
[ -n "$S" ] || S=-1
if [ "$J" -le -1 ] || [ "$T" -le -1 ] || [ "$S" -le -1 ]; then LEFT=-1; else LEFT=$(( J + T + S )); fi
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
# 低内存要连续两次才算：一次抽样就撤窗，等于把窗口交给最抖的那一格读数。
PREV=$(cat /run/geohot-r114-lowmem 2>/dev/null || echo 0)
STREAK=$(next_streak "$PREV" "${AVAIL:-0}" "$GEOHOT_FLOOR_AVAIL_MB")
mkdir -p /run 2>/dev/null && printf '%s' "$STREAK" > /run/geohot-r114-lowmem 2>/dev/null
# 停摆检测：真没在判完 = 停摆（门被板凳、worker 卡住、队列被钉住）。
# 静默等到死期限是最贵的一种失败：这几天什么都不产出，还占着实时。连续 18 轮（3 小时）零判完才恢复实时。
# **存量只看判定腿($J)，但"在不在干活"以近 30 分钟判完条数($DONE)为准**——19:21 开窗后头一小时存量必涨
# （归档进口 +15/轮，队列先消化实时带残留 233 条），拿存量差判停摆会在此刻把窗口撤掉。
# 一次查询取两个数：全部判完($DONE，用来判"这台机还在不在产出"）与**档案带**判完($DONEA，用来判"回填有没有被吃掉槽位"）。
# 分带这件事不能省：对抗审计指出 DONE 不分带会让"档案带永远轮不到、别的带一直在产"这种形状变成永久绿——
# 那种形状的解药是份额（`rebalance-archive-queue.ts:11—16` 写着只有站长能动），不是撤窗，所以它只报警不动手。
# 状态一行四列：上次判定存量、上次停摆计数、上次看不见计数、上次饿着计数（只存存量就会把存量当计数，见 next_stall 的注释）。
DONEPAIR=$(PGOPTIONS="-c statement_timeout=25s" psql "$DATABASE_URL" -At -F'|' -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FILTER (WHERE a.timeline_at < '2026-10-01+08'), count(*) FROM analyses n JOIN articles a ON a.id = n.article_id WHERE n.created_at > now()-interval '30 minutes'" 2>/dev/null | tail -1)
DONEA=$(digits_only "$(printf '%s' "$DONEPAIR" | cut -d'|' -f1)")
DONE=$(digits_only "$(printf '%s' "$DONEPAIR" | cut -d'|' -f2)")
STARVE_N=${R114_ARCHIVE_STARVE_ROUNDS:-36}
STATE=$(cat /run/geohot-r114-left 2>/dev/null || echo '')
PREVJ=$(printf '%s' "$STATE" | cut -d' ' -f1)
PREVSTALL=$(printf '%s' "$STATE" | cut -d' ' -f2)
PREVBLIND=$(printf '%s' "$STATE" | cut -d' ' -f3)
PREVSTARVE=$(printf '%s' "$STATE" | cut -d' ' -f4)
STALL=$(next_stall "$PREVJ" "$PREVSTALL" "$J" "$DONE")
STARVE=$(next_starve "$PREVSTARVE" "$DONEA")
E5_WINDOW_SEC=${R114_E5_WINDOW_SEC:-700}
NOWE=$(date +%s)
TODAY0=$(date -d "today 00:00:00" +%s 2>/dev/null || echo 0)
E5RAO=$(e5_count "${R114_NGX:-/var/log/nginx/access.log}" "${R114_E5_TAIL:-20000}" "$E5_WINDOW_SEC" \
  "$(LC_ALL=C date +%d/%b/%Y)" "$TODAY0" "$NOWE" \
  "$(LC_ALL=C date -d yesterday +%d/%b/%Y 2>/dev/null)" "$(( TODAY0 - 86400 ))")
E5=$(printf '%s' "$E5RAO" | cut -d' ' -f1)
E5N=$(printf '%s' "$E5RAO" | cut -d' ' -f2)
E5SPAN=$(printf '%s' "$E5RAO" | cut -d' ' -f3)
case "$E5" in ''|*[!0-9]*) E5=-1 ;; esac
# 开窗时刻：优先拿关阀旗标的 mtime（跨午夜也读得到，且不依赖本轮会话活着）。
# 旗标读不到时退到 /run 那份备份（2026-10-18 对抗代理 M5：`date -r` 失败会 echo 0，而 decide 里"0=不按上限收口"，
# 于是 `/etc/geohot` 一旦没了/写失败，**单窗上限这一条就静默消失**，只剩死期限那条六天外的界）。两个都没有才传 0。
OPENED=$(date -r /etc/geohot/r114-stop.done +%s 2>/dev/null || cat /run/geohot-r114-opened 2>/dev/null || echo 0)
# 看不见 = 存量、读者面 5xx、"有没有在干活"任一读不到合法数字；连续 GEOHOT_BLIND_STREAK 轮就恢复实时（瞎着的哨兵没资格替站长按着进口）。
# 第四个参数是这一轮新加的：判完那把尺死了必须**当成瞎一格**，否则它会安静退回"比存量差"的旧口径，
# 而旧口径正是这一轮杀掉的误撤窗规则——死量具不能换个门重新进来。
BLIND=$(next_blind "$PREVBLIND" "$LEFT" "$E5" "$DONE")
# 存量这一列只在读到数字时才更新：把 -1 写进状态文件，下一轮 next_stall 会因"上次不是数字"直接归零，
# 于是一次 psql 抖动就把停摆计数清空（停摆这条保命规则变成永远够不着）。
NEWJ="$J"; case "$J" in ''|*[!0-9]*) NEWJ="$PREVJ" ;; esac
mkdir -p /run 2>/dev/null && printf '%s %s %s %s' "$NEWJ" "$STALL" "$BLIND" "$STARVE" > /run/geohot-r114-left 2>/dev/null
E5FORJUDGE="$E5"; [ "$E5" -lt 0 ] && E5FORJUDGE=0
ACT=$(decide "$LEFT" "${AVAIL:-0}" "$E5FORJUDGE" "$NOWE" "${DEADLINE_EPOCH:-0}" "$STREAK" "$STALL" "$BLIND" "$OPENED")
echo "$(date -Is) watch 待判=$J 待翻=$T 未扫片=$S 合计=$LEFT 判完30min=全部$DONE/档案$DONEA avail=${AVAIL:-?}MB lowmem_streak=$STREAK stall_streak=$STALL starve_streak=$STARVE/$STARVE_N blind=$BLIND err5xx=${E5}/${E5_WINDOW_SEC}s(样本${E5N:-?}行 ${E5SPAN:-无}) 已开$(( OPENED>0 ? (NOWE-OPENED)/60 : 0 ))min -> $ACT"
# 饿着只报警、不改窗口去留：档案带被别的带吃掉槽位时，恢复实时只会让那条带更长；解药在站长手里（份额旋钮）。
[ "$STARVE" -ge "$STARVE_N" ] && echo "$(date -Is) watch STARVE-ALERT 档案带已连续 ${STARVE} 轮零判完（按默认 10 分钟一轮约 $(( STARVE * 10 / 60 )) 小时；哨兵节奏若改过要按 timer 自己的 OnCalendar 折算）, 同期全部判完=$DONE 条、待判=$J —— 这是份额问题不是死人问题：撤窗帮不上，要动的是 scripts/rebalance-archive-queue.ts --promote（脚本自己写着只有站长能动）"
case "$ACT" in
  RESTORE*)
    R114_FORCE=1 bash "$BIN/r114-restore-realtime.sh"; rc=$?
    echo "$(date -Is) watch-restore rc=$rc ($ACT)"
    if [ "$rc" != 0 ]; then
      # 恢复失败就绝不能拆哨兵：阀还关着、又没人再问下一次，就是"没人看着的黑洞"。留着它 10 分钟后再试。
      echo "$(date -Is) watch-restore-failed 保留哨兵与全部定时器（现值 $(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF" 2>/dev/null)）"
      exit 0
    fi
    systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
    systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
    echo "$(date -Is) watch-done 哨兵与两枚窗口定时器已拆"
    # 排空或过了最迟期限：连"每晚 21:00 再关一次阀"也一起停——没活可干就别再占实时。
    # 其余原因（5xx／低内存／停摆／看不见／单窗上限）不动它，明晚照开。
    case "$ACT" in
      *drained*|*deadline*)
        systemctl disable --now geohot-r114-longwindow-start.timer 2>/dev/null
        systemctl start geohot-archive.timer 2>/dev/null
        echo "$(date -Is) watch-nightly-off 依据 $ACT 收工：晚间排程已拆，归档周期交回日常节律（active=$(systemctl is-active geohot-archive.timer 2>&1)）"
        ;;
      *)
        # 还在夜窗政策里才按住白天这一档；晚间排程已不在（--disarm-nightly 之后）再 stop 就没人负责起回来了。
        if [ "$(systemctl is-enabled geohot-r114-longwindow-start.timer 2>/dev/null)" = "enabled" ]; then
          systemctl stop geohot-archive.timer 2>/dev/null
          echo "$(date -Is) watch-archive-daypause 白天按住归档周期（active=$(systemctl is-active geohot-archive.timer 2>&1)），今晚由 --start 再放行"
        else
          echo "$(date -Is) watch-archive-normal 晚间排程已不在，归档周期留在日常节律（active=$(systemctl is-active geohot-archive.timer 2>&1)）"
        fi
        ;;
    esac
    ;;
esac
WATCH
}

gate_body() { cat <<'GATE'
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
COOL=${R115_COOLDOWN_MIN:-30}
. "$BIN/r114-drain-decide.sh"
# 判据文件必须是带 gate_action 的那一份。18:53 装机时它还是 18:25 那版（没有这个函数），
# 于是每次运行只留下一行 command not found、case 谁都匹配不上、什么也不做——一个安静失效的假闸门。
declare -F gate_action >/dev/null || { echo "$(date -Is) FATAL 判据文件缺 gate_action（先 --refresh 或 --gate-on 重装判据）"; exit 1; }
declare -F e5_count >/dev/null || { echo "$(date -Is) FATAL 判据文件缺 e5_count"; exit 1; }
NOW=$(date +%s); T0=$(date -d "today 00:00:00" +%s 2>/dev/null || echo 0)
RAO=$(e5_count "${R114_NGX:-/var/log/nginx/access.log}" "${R114_E5_TAIL:-20000}" "$WIN" \
  "$(LC_ALL=C date +%d/%b/%Y)" "$T0" "$NOW" \
  "$(LC_ALL=C date -d yesterday +%d/%b/%Y 2>/dev/null)" "$(( T0 - 86400 ))")
E5=$(printf '%s' "$RAO" | cut -d' ' -f1)
SPAN=$(printf '%s' "$RAO" | cut -d' ' -f3)
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
      systemctl stop geohot-worker; RC=$?
      ACT=$(systemctl is-active geohot-worker 2>&1); ACTIVE_RC=$?
      # 停止意图已经承担恢复责任；stop/读回失败也保留它，下一轮按 active/inactive 收口。
      if [ "$RC" -eq 0 ] && [ "$ACTIVE_RC" -eq 3 ] && [ "$ACT" = inactive ]; then
        echo "$(date -Is) TRIPPED 5xx=$E5/${WIN}s(样本 $SPAN) valve=$V worker=$ACT stop_rc=$RC 冷却 ${COOL} 分钟"
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
      RC=0
      if [ "$A" = RELEASE ]; then systemctl start geohot-worker; RC=$?; fi
      ACT=$(systemctl is-active geohot-worker 2>&1); ACTIVE_RC=$?
      # 启动回执与实际读回都成功才交清恢复责任；已有 active 也要重新读回。
      # 失败留原状态，下一轮会重试启动，或确认已恢复的 worker 后再清责任。
      if [ "$RC" -eq 0 ] && [ "$ACTIVE_RC" -eq 0 ] && [ "$ACT" = active ]; then
        rm -f "$RUN" 2>/dev/null || { echo "$(date -Is) RELEASE-STATE-FAILED worker=$ACT 状态文件保留待重试"; exit 1; }
        echo "$(date -Is) RELEASED 5xx=0/${WIN}s(样本 $SPAN) worker=$ACT start_rc=$RC"
      else
        echo "$(date -Is) RELEASE-FAILED worker=$ACT start_rc=$RC active_rc=$ACTIVE_RC 状态文件保留待重试"
        exit 1
      fi
    fi
    ;;
  HELD)
    echo "$(date -Is) HELD 冷却还剩 $(( (UNTIL - NOW) / 60 )) 分钟 worker=$ACT 5xx=${E5}/${WIN}s"
    ;;
  SKIP_BLIND)
    echo "$(date -Is) SKIP 5xx 量具读不到（nginx 无当日样本或字段漂移）——闸门不动生产，但这不是绿灯" ;;
  SKIP_DISARMED) echo "$(date -Is) SKIP disarmed 旗标在 $DISARM" ;;
  SKIP_OPERATOR_STOPPED) echo "$(date -Is) SKIP worker=$ACT 非本闸门停止，5xx=$E5，不认领恢复责任" ;;
  *) echo "$(date -Is) IDLE 5xx=${E5}/${WIN}s(样本 $SPAN) worker=$ACT valve=$V 冷却文件=[$(cat "$RUN" 2>/dev/null)]" ;;
esac
GATE
}

unit_svc() { printf '[Unit]\nDescription=%s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nEnvironment=R114_DEADLINE_EPOCH=%s\nEnvironment=R114_FLOOR_AVAIL_MB=%s\nEnvironment=R114_BUDGET_ERR5XX=%s\nEnvironment=R114_LOWMEM_STREAK=%s\nEnvironment=R114_STALL_STREAK=%s\nEnvironment=R114_BLIND_STREAK=%s\nEnvironment=R114_E5_WINDOW_SEC=%s\nEnvironment=R114_MAX_WINDOW_SEC=%s\nExecStart=/bin/bash %s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}"; }
unit_tm() { # unit_tm <单元名> <描述> <OnCalendar> [Persistent]（默认 false：错过一轮不补跑）
  # 第 4 个参数是为"每晚只响一次的开窗"加的：那一枚错过一次就少一整夜，必须补跑；
  # 哨兵与闸门每一轮都一样，错过就错过，绝不能开机时补一堆（2026-10-18 21:00 那一枪就是这么静悄悄丢掉的）。
  printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30\nPersistent=%s\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$2" "$3" "${4:-false}" "$1"; }
unit_gate_svc() { printf '[Unit]\nDescription=GEOHOT reader-first worker gate\n\n[Service]\nType=oneshot\nUser=root\nEnvironment=R115_E5_WINDOW_SEC=%s\nEnvironment=R115_COOLDOWN_MIN=%s\nEnvironment=R114_NGX=/var/log/nginx/access.log\nExecStart=/bin/bash %s\n' "$1" "$2" "$3"; }
GATE_CADENCE=${R115_GATE_CADENCE:-"*:03/10"}
COOLDOWN=${R115_COOLDOWN_MIN:-30}
GATE_SCRIPT=${R115_GATE_SCRIPT:-$BIN/r115-reader-gate.sh}

install_gate() { # 只落闸门脚本，不 enable
  mkdir -p "$BIN"
  gate_body > "$GATE_SCRIPT.tmp" && mv "$GATE_SCRIPT.tmp" "$GATE_SCRIPT"; chmod 700 "$GATE_SCRIPT"; chown root:root "$GATE_SCRIPT"
  unit_gate_svc "$E5WIN" "$COOLDOWN" "$GATE_SCRIPT" > "$SYS/geohot-r115-reader-gate.service"
  unit_tm geohot-r115-reader-gate "GEOHOT reader-first worker gate (10 min)" "$GATE_CADENCE" > "$SYS/geohot-r115-reader-gate.timer"
  systemctl daemon-reload
  ls -l "$GATE_SCRIPT" | awk '{print "  gate_script="$1, $5, $9}'
}

install_files() { # 落盘判据与哨兵，并重装两枚单元；不碰阀门、不 enable
  mkdir -p "$BIN"
  decide_body > "$DECIDE.tmp" && mv "$DECIDE.tmp" "$DECIDE"; chmod 700 "$DECIDE"; chown root:root "$DECIDE"
  watch_body  > "$WATCH.tmp"  && mv "$WATCH.tmp"  "$WATCH";  chmod 700 "$WATCH";  chown root:root "$WATCH"
  ls -l "$DECIDE" "$WATCH" | awk '{print $1, $5, $9}'
  unit_svc geohot-r114-drain-watch "GEOHOT long-window drain sentinel" "$DEADLINE_EPOCH" "$FLOOR" "$BUDGET" "$STREAK_N" "$STALL_N" "$BLIND_N" "$E5WIN" "$MAXSEC" "$WATCH" > "$SYS/geohot-r114-drain-watch.service"
  unit_tm  geohot-r114-drain-watch "GEOHOT long-window drain sentinel (10 min)" "$CADENCE" > "$SYS/geohot-r114-drain-watch.timer"
  systemctl daemon-reload
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
  export GEOHOT_FLOOR_AVAIL_MB="$FLOOR" GEOHOT_BUDGET_ERR5XX="$BUDGET" GEOHOT_LOWMEM_STREAK="$STREAK_N" GEOHOT_STALL_STREAK="$STALL_N" GEOHOT_BLIND_STREAK="$BLIND_N"
  chk() { # chk <说明> <期望动作> <剩余> <可用> <5xx> <现在> <期限> <低内存连击> <停摆连击> <看不见连击> <开窗epoch>
    # 期望里带 "|" 就逐字比（把撤窗理由也钉住），只给类别名（RESTORE／HOLD）才做前缀比。
    local got ok=0; got=$(decide "$3" "$4" "$5" "$6" "$7" "${8:-1}" "${9:-0}" "${10:-0}" "${11:-0}")
    case "$2" in
      *"|"*) [ "$got" = "$2" ] && ok=1 ;;
      *) case "$got" in "$2"*) ok=1 ;; esac ;;
    esac
    [ "$ok" = 1 ] && echo "  OK   $1 → $got" || { echo "  WRONG $1：期望 [$2] 得到 [$got]"; exit 1; }
}
  chk "排空（0 条）"            RESTORE 0    300 0 1000 2000 1
  chk "未排空且健康"            HOLD   1200  300 0 1000 2000 1
  chk "读者面出 5xx"            RESTORE 1200 300 3 1000 2000 1
  chk "低内存第一次（不算）"    HOLD   1200  40 0 1000 2000 1
  chk "低内存第三次（要撤）"    RESTORE 1200 40 0 1000 2000 3
  chk "到最迟期限"              RESTORE 1200 300 0 2500 2000 1
  # 低内存未攒够连击时只能暂缓内存规则，不能遮住已经到达的硬期限。
  chk "到期限 + 低内存第一次" "RESTORE|deadline" 1200 40 0 2000 2000 1
  chk "过期限 + 低内存第二次" "RESTORE|deadline" -1 40 0 2500 2000 2
  chk "存量读不到（-1）"        HOLD     -1   300 0 1000 99999999999 1
  # 证这把尺真的有电：相邻的两个数必须给相反的答案。
  chk "只差一条就不算排空"      HOLD      1   300 0 1000 2000 1
  chk "5xx 预算 0 时一条也算红" RESTORE 1200 300 1 1000 2000 1
  # 计数器本身也要测：坏读数（空、非数字）不能把窗口拖垮，也不能让它一次抖动就撤窗。
  [ "$(next_streak 0 40 60)" = 1 ] && [ "$(next_streak 1 40 60)" = 2 ] && [ "$(next_streak 2 300 60)" = 0 ] \
    && echo "  OK   next_streak：40→1、再 40→2、回到 300 归零" || { echo "  WRONG 低内存计数器不对"; exit 1; }
  # 地板刚从 90 降到 60 的理由要能被测到：17:22 生产读到 avail=86MB（正常范围内），它不该被记成低内存。
  chk "86 MB（生产刚读到的值）不算低内存"  HOLD 1200 86 0 1000 2000 1
  [ "$(next_streak '' 60 90)" = 1 ] && [ "$(next_streak x y 90)" = 1 ] && echo "  OK   坏读数（空/非数字）当 0 处理：仍从第一次算起，不会直接撤窗" \
    || { echo "  WRONG 坏读数没被兜住"; exit 1; }
  # 停摆：静默等到死期限是最贵的失败，所以"零判完且存量不降"要能自己撤窗；但第一轮不记账、降了就归零。
  [ "$(next_stall '' 0 14692)" = 0 ] && [ "$(next_stall 14692 0 14692)" = 1 ] && [ "$(next_stall 14692 4 14692)" = 5 ] \
    && [ "$(next_stall 14692 3 14690)" = 0 ] \
    && echo "  OK   next_stall：首轮 0、持平 +1、4→5、有降归零" || { echo "  WRONG 停摆计数器不对"; exit 1; }
  # 相邻数证明它有电：读不到存量时必须**不记账**，否则一次 psql 抖动就把窗口撤了。
  [ "$(next_stall 14692 5 '')" = 5 ] && echo "  OK   存量读不到时计数保持不动（不 +1 也不归零，绝不撤窗）" \
    || { echo "  WRONG 坏读数会推进停摆计数"; exit 1; }
  # 第 4 个输入（近 30 分钟判完条数）——这一条是为 19:21 开窗后头一小时那个形状写的：存量在涨（进口 +15/轮、
  # 队列先消化实时带残留），但 97 条确实在判完。只比存量会把窗口在 22:2x 撤掉，把站长明令先停的实时放回来。
  [ "$(next_stall 14760 1 14774 66)" = 0 ] && echo "  OK   存量在涨但有判完(66 条/30min) → 归零：正在干活不叫停摆" \
    || { echo "  WRONG 判完证据没接进停摆计数（窗口会在头一小时被误撤）"; exit 1; }
  [ "$(next_stall 14760 1 14774 0)" = 2 ] && echo "  OK   存量在涨且零判完 → 照常 +1：真停摆仍然够得着" \
    || { echo "  WRONG 判完=0 时不再推进计数，停摆这条成了永远够不着的死规则"; exit 1; }
  [ "$(next_stall 14760 1 14774 '')" = 2 ] && [ "$(next_stall 14760 1 14774 x)" = 2 ] && [ "$(next_stall 14760 1 14774 -1)" = 2 ] \
    && echo "  OK   判完读不到（空/非数字/**-1**，生产就是这三个形状）→ 退回旧口径 +1，不把'读不到'当'在干活'" \
    || { echo "  WRONG 坏判完读数被当成了干活证据"; exit 1; }
  # 量具死了不能只是"退回旧口径"就完事——那等于这条 commit 要杀的规则换个门重新进来。它必须同时被数成"瞎一格"。
  [ "$(next_blind 0 14692 0 -1)" = 1 ] && [ "$(next_blind 0 14692 0 x)" = 1 ] && [ "$(next_blind 0 14692 0 66)" = 0 ] \
    && echo "  OK   next_blind 接了第 4 把尺：判完量具死了＝瞎一格，活着且有产出＝归零" \
    || { echo "  WRONG 死掉的判完量具没被数进看不见，哨兵会安静用回旧口径"; exit 1; }
  # 没传第 4 个参数必须**完全不参与**（旧夹具与任何漏改的调用点都不能被这条改动带红）。
  [ "$(next_blind 0 14692 0)" = 0 ] && [ "$(next_blind 2 14692 0)" = 0 ] \
    && echo "  OK   只给三个参数时 next_blind 保持原语义（新尺默认不参与，夹具不会被改坏）" \
    || { echo "  WRONG 三参数调用被第四把尺污染"; exit 1; }
  # 档案带"饿着"计数：这是对抗审计打出来的那条——判完总数不分带，会让"别的带一直在产、回填一条轮不到"变成永久绿。
  [ "$(next_starve '' 5)" = 0 ] && [ "$(next_starve 7 0)" = 8 ] && [ "$(next_starve 7 -1)" = 7 ] && [ "$(next_starve 7 x)" = 7 ] \
    && echo "  OK   next_starve：档案带有判完归零、零判完 +1、读不到保持不动（既不推进也不清空）" \
    || { echo "  WRONG 饿着计数器不对"; exit 1; }
  grep -q 'STARVE-ALERT' "$T/watch.sh" \
    && echo "  OK   哨兵里确有那条饿着报警行（只报警不动窗口——解药是份额，写着只有站长能动）" \
    || { echo "  WRONG 饿着报警没落进哨兵"; exit 1; }
  grep -q "RESTORE|stalled=\${stalled}轮_零判完" "$T/decide.sh" \
    && echo "  OK   撤窗理由写的是'零判完'，不再是那句已作废的'存量未降'" \
    || { echo "  WRONG 撤窗文案还在说存量未降（打印会骗下一个读日志的人）"; exit 1; }
  chk "停摆 17 轮（还没到阈值）" HOLD    1200 300 0 1000 2000 1 17
  chk "停摆 18 轮 → 撤窗"        RESTORE 1200 300 0 1000 2000 1 18
  # 单窗上限（9.5 小时）：天亮前必须让回实时，且不依赖"另一半定时器有没有跑成"。now=100000，期限给到无穷远以免抢先。
  chk "开窗 8 小时（未到上限）"    HOLD    1200 300 0 100000 99999999999 1 0 0 71200
  chk "开窗 9.6 小时 → 撤窗"      RESTORE 1200 300 0 100000 99999999999 1 0 0 65440
  chk "单窗上限前 1 秒 + 低内存第一次" HOLD 1200 40 0 100000 99999999999 1 0 0 65801
  chk "恰到单窗上限 + 低内存第一次" "RESTORE|max_window=570min" 1200 40 0 100000 99999999999 1 0 0 65800
  chk "超过单窗上限 + 低内存第二次" "RESTORE|max_window=576min" -1 40 0 100000 99999999999 2 0 0 65440
  chk "开窗时刻未知（0）不按上限"   HOLD    1200 300 0 100000 99999999999 1 0 0 0
  # —— 本轮修的顺序：量具读不到时，读者的 5xx／低内存／期限必须仍然撤得了窗。
  # 17:34—17:36 那两条 HOLD|unknown_left 里就藏着 err5xx=30/45，旧写法把 unknown_left 顶在第一行，一坏全盲。
  chk "存量读不到 + 读者面 5xx → 撤窗"   RESTORE   -1 300 5 1000 2000 1 0 0
  chk "存量读不到 + 低内存第三次 → 撤窗"  RESTORE   -1  40 0 1000 2000 3 0 0
  chk "存量读不到 + 已到最迟期限 → 撤窗"  RESTORE   -1 300 0 2500 2000 1 0 0
  chk "存量读不到但量具只坏两轮 → 继续 HOLD" HOLD   -1 300 0 1000 2000 1 0 2
  chk "连续 3 轮看不见 → 撤窗"           RESTORE   -1 300 0 1000 2000 1 0 3
  [ "$(next_blind 0 -1 3)" = 1 ] && [ "$(next_blind 2 -1 '')" = 3 ] && [ "$(next_blind 3 14692 0)" = 0 ] && [ "$(next_blind 1 14692 -1)" = 2 ] \
    && echo "  OK   next_blind：存量-1→+1、5xx 读不到→+1、两个都好→归零" || { echo "  WRONG 看不见计数器不对"; exit 1; }
  # 5xx 尺自己也要被量：合成一份 nginx 日志，四条行分别该"进窗/进窗/出窗/非本站/非 5xx"。
  # 这条夹具是为本轮踩过的那个偏移坑写的——$4 的小时从第 14 个字符起，写成 13 会把小时读成 0，窗口过滤器就永远数不到（假绿）。
  DPF=$(LC_ALL=C date +%d/%b/%Y); T0F=1000000000; NOWF=$(( T0F + 17*3600 + 34*60 + 30 ))
  { printf '1.1.1.1 - - [%s:17:34:00 +0800] "GET /geohot/ HTTP/1.1" 503 12 "-" "probe"\n' "$DPF"
    printf '1.1.1.1 - - [%s:17:00:00 +0800] "GET /geohot/reports HTTP/1.1" 504 12 "-" "probe"\n' "$DPF"
    printf '1.1.1.1 - - [%s:16:00:00 +0800] "GET /geohot/ HTTP/1.1" 500 12 "-" "probe"\n' "$DPF"
    printf '1.1.1.1 - - [%s:17:30:00 +0800] "GET /other/ HTTP/1.1" 503 12 "-" "probe"\n' "$DPF"
    printf '1.1.1.1 - - [%s:17:29:00 +0800] "GET /geohot/ HTTP/1.1" 200 12 "-" "probe"\n' "$DPF"
  } > "$T/acc.log"
  R40=$(e5_count "$T/acc.log" 500 2400 "$DPF" "$T0F" "$NOWF")
  R2H=$(e5_count "$T/acc.log" 500 7200 "$DPF" "$T0F" "$NOWF")
  [ "$(printf '%s' "$R40" | cut -d' ' -f1)" = 2 ] || { echo "  WRONG 40 分钟窗该数到 2 条（17:34 与 17:00），得到 [$R40]"; exit 1; }
  [ "$(printf '%s' "$R2H" | cut -d' ' -f1)" = 3 ] || { echo "  WRONG 2 小时窗该数到 3 条（16:00 那条要进来），得到 [$R2H]"; exit 1; }
  [ "$(printf '%s' "$R40" | cut -d' ' -f3)" = "17:34-17:29" ] || { echo "  WRONG 跨度显示不对（说明 substr 偏移又漂了），得到 [$R40]"; exit 1; }
  echo "  OK   e5_count：40 分钟窗 2 条／2 小时窗 3 条／跨度显示 17:34-17:29（非本站与非 5xx 都没被误数）"
  # 死掉的量具不能报 0：nginx 读不到、或日期前缀对不上（LC_TIME 非英文就会这样），必须给 -1 让 blind 涨。
  RDEAD=$(e5_count "$T/不存在的日志" 500 700 "$DPF" "$T0F" "$NOWF")
  [ "$(printf '%s' "$RDEAD" | cut -d' ' -f1)" = -1 ] \
    && echo "  OK   日志读不到时 e5_count 给 -1（不是 0）：[$RDEAD]" || { echo "  WRONG 死掉的 5xx 量具报成 0，读者规则就永远够不着"; exit 1; }
  RCN=$(e5_count "$T/acc.log" 500 700 "18/十月/2026" "$T0F" "$NOWF")
  [ "$(printf '%s' "$RCN" | cut -d' ' -f1)" = -1 ] \
    && echo "  OK   月份前缀不匹配（locale 漂移）也给 -1：[$RCN]" || { echo "  WRONG locale 一改这把尺就永远数到 0"; exit 1; }
  # —— 午夜盲点（2026-10-19 00:00 真机抓到：`err5xx=0/700s(样本2行 00:00-00:00)`）：
  # 700 秒窗天生跨午夜，旧实现只匹配"今天"的日期前缀 ⇒ 00:00—00:11 之间窗口被截成几十秒、读数还是 0（不是 -1，blind 也不会涨）。
  # 新语义：昨天 23:59 的 5xx 照样数进来；昨天 20:00 那条（远在窗外）不许进；六参数旧调用保持"只看今天"。
  DY='08/Sep/2001'; DT='09/Sep/2001'; T0Y=1000000000; T0T=$(( T0Y + 86400 )); NOWM=$(( T0T + 300 ))
  { printf '1.1.1.1 - - [%s:23:59:00 +0800] "GET /geohot/ HTTP/1.1" 503 12 "-" "probe"\n' "$DY"
    printf '1.1.1.1 - - [%s:20:00:00 +0800] "GET /geohot/ HTTP/1.1" 502 12 "-" "probe"\n' "$DY"
    printf '1.1.1.1 - - [%s:00:04:00 +0800] "GET /geohot/ HTTP/1.1" 503 12 "-" "probe"\n' "$DT"
  } > "$T/acc2.log"
  RM=$(e5_count "$T/acc2.log" 500 700 "$DT" "$T0T" "$NOWM" "$DY" "$T0Y")
  [ "$(printf '%s' "$RM" | cut -d' ' -f1)" = 2 ] \
    && echo "  OK   跨午夜窗口数到 2 条（昨天 23:59 + 今天 00:04），昨天 20:00 那条没被算：[$RM]" \
    || { echo "  WRONG 跨午夜窗口应数到 2 条，得到 [$RM]（午夜后 11 分钟里守卫会瞎）"; exit 1; }
  RM6=$(e5_count "$T/acc2.log" 500 700 "$DT" "$T0T" "$NOWM")
  [ "$(printf '%s' "$RM6" | cut -d' ' -f1)" = 1 ] \
    && echo "  OK   六参数旧调用仍只数今天 1 条（向后兼容，不把昨天的旧行误算进来）" \
    || { echo "  WRONG 六参数语义变了，得到 [$RM6]"; exit 1; }
  [ "$(digits_only 'Time: 3.501 ms')" = -1 ] && [ "$(digits_only 14693)" = 14693 ] && [ "$(digits_only '')" = -1 ] \
    && echo "  OK   digits_only：把 psql 多打的那行（\\timing）挡成 -1，不制造 3501 这种假存量" || { echo "  WRONG 假数没被挡住"; exit 1; }
  # 读者优先闸门（第 115 轮新增）：TRIP／HELD／RELEASE／SKIP 四条路都要能被夹具走到。
  [ "$(gate_action 3 1000 0 0 active 0 0)" = TRIP ] \
    && echo "  OK   gate：5xx=3 且没在冷却 → TRIP" || { echo "  WRONG 闸门见到 5xx 不跳"; exit 1; }
  [ "$(gate_action 3 1000 0 0 inactive 0 0)" = SKIP_OPERATOR_STOPPED ] \
    && echo "  OK   gate：operator 已停的 worker 遇红也不认领" || { echo "  WRONG 闸门会认领 operator 已停的 worker"; exit 1; }
  [ "$(gate_action 0 1000 9999999999 1 inactive 0 0)" = HELD ] \
    && echo "  OK   gate：冷却没到就 HELD（不会反复停/起 worker）" || { echo "  WRONG 冷却期被无视"; exit 1; }
  [ "$(gate_action 0 10000 9000 1 inactive 0 0)" = RELEASE ] \
    && echo "  OK   gate：冷却已过、5xx 归零、且本闸门承担恢复责任 → RELEASE" || { echo "  WRONG 闸门不会把 worker 交回去"; exit 1; }
  [ "$(gate_action 0 10000 9000 1 active 0 0)" = CONFIRM_RELEASE ] \
    && echo "  OK   gate：本闸门责任尚在且 worker 已 active → 确认恢复" || { echo "  WRONG 已 active 的恢复责任没有收口路径"; exit 1; }
  [ "$(gate_action 0 10000 0 0 inactive 0 0)" = IDLE ] \
    && echo "  OK   gate：不是我们停的 worker 就绝不去 start（operator 手工停的保持原样）" || { echo "  WRONG 闸门会擅自启动别人停的进程"; exit 1; }
  [ "$(gate_action -1 1000 0 1 active 0 0)" = SKIP_BLIND ] && [ "$(gate_action 9 1000 0 1 active 0 1)" = SKIP_DISARMED ] \
    && echo "  OK   gate：量具坏→SKIP_BLIND（不动生产但也不装绿）；disarmed 旗标在→谁也不动" || { echo "  WRONG 闸门在坏量具或被解除时还动生产"; exit 1; }
  [ "$(gate_action x 1000 '' '' active 0 0)" = SKIP_BLIND ] \
    && echo "  OK   gate：非数字入参被兜住（不会把 shell 报错当成一次跳闸）" || { echo "  WRONG 非数字入参没兜住"; exit 1; }
  bash -n "$T/watch.sh" >/dev/null && grep -q 'gate_action' "$T/decide.sh" \
    && echo "  OK   闸门判据与哨兵判据同源（同一份 decide 文件，测的=跑的）" || { echo "  WRONG 闸门另抄了一份判据"; exit 1; }
  gate_body > "$T/gate.sh"; bash -n "$T/gate.sh" && echo "  OK   闸门脚本语法过" || { echo "  WRONG 闸门脚本语法不过"; exit 1; }
  # 离线跑完整闸门：真实判据/日志尺，只有 systemctl 用受控替身；路径全部落在临时目录。
  # 替身拒绝未声明动作，绝不调用本机或生产 systemctl。
  mkdir -p "$T/gate-bin"
  cp "$T/decide.sh" "$T/gate-bin/r114-drain-decide.sh"
  printf 'COLLECT_ENABLED=false\n' > "$T/gate-valve"
  printf '1.1.1.1 - - [%s] "GET /geohot/ HTTP/1.1" 200 12 "-" "fixture"\n' \
    "$(LC_ALL=C date '+%d/%b/%Y:%H:%M:%S %z')" > "$T/gate-access"
  gate_fixture() (
    local mode="$1" rc=0
    export FIX_MODE="$mode" FIX_CALLS="$T/gate-calls" FIX_INITIAL_ACTIVE=0
    export GEOHOT_BIN="$T/gate-bin" R114_ENVF="$T/gate-valve" R114_NGX="$T/gate-access"
    export R115_RUN="$T/gate-run" R115_LOG="$T/gate-log" R115_DISARM="$T/gate-disarmed" R115_DRY=0
    export R115_BUDGET_ERR5XX=0 R115_E5_WINDOW_SEC=700
    printf '1 1\n' > "$R115_RUN"; : > "$FIX_CALLS"; : > "$R115_LOG"
    systemctl() {
      case "$*" in
        'start geohot-worker')
          echo start >> "$FIX_CALLS"
          case "$FIX_MODE" in start-fails|start-fails-active) return 1 ;; esac ;;
        'is-active geohot-worker')
          if [ "$FIX_INITIAL_ACTIVE" = 1 ]; then echo active; return 0; fi
          if [ -s "$FIX_CALLS" ]; then
            case "$FIX_MODE" in
              success|remove-fails|start-fails-active) echo active; return 0 ;;
              readback-fails) echo active; return 3 ;;
            esac
          fi
          echo inactive; return 3 ;;
        *) echo "UNEXPECTED systemctl $*" >&2; return 99 ;;
      esac
    }
    export -f systemctl
    rm() {
      if [ "$*" = "-f $R115_RUN" ]; then
        case "$FIX_MODE" in remove-fails|confirm-remove-fails) return 1 ;; esac
      fi
      command rm "$@"
    }
    export -f rm
    case "$mode" in confirm-active|confirm-remove-fails) FIX_INITIAL_ACTIVE=1 ;; esac
    [ "$mode" != blind ] || R114_NGX="$T/no-access-log"
    export R114_NGX
    bash "$T/gate.sh" || rc=$?
    case "$mode" in
      start-fails|inactive|start-fails-active|readback-fails|remove-fails|confirm-remove-fails)
        [ "$rc" -ne 0 ] && [ "$(cat "$R115_RUN" 2>/dev/null)" = '1 1' ] \
          && ! grep -q ' RELEASED ' "$R115_LOG" \
          || { echo "  WRONG gate $mode：失败必须报非零并保留恢复责任，rc=$rc state=[$(cat "$R115_RUN" 2>/dev/null)]"; cat "$R115_LOG"; exit 1; }
        # 下一轮真实脚本必须会重试，并在读回 active 后才清责任。
        local expected=1
        [ "$mode" != confirm-remove-fails ] || expected=0
        [ "$(wc -l < "$FIX_CALLS")" -eq "$expected" ] || { echo "  WRONG gate $mode：首轮启动次数不对"; exit 1; }
        case "$mode" in
          start-fails-active|remove-fails|confirm-remove-fails) FIX_INITIAL_ACTIVE=1; expected=0 ;;
        esac
        export FIX_MODE=success; : > "$FIX_CALLS"
        bash "$T/gate.sh" && [ ! -e "$R115_RUN" ] && [ "$(wc -l < "$FIX_CALLS")" -eq "$expected" ] \
          || { echo "  WRONG gate $mode：下一轮没有成功重试"; exit 1; } ;;
      success|confirm-active)
        [ "$rc" = 0 ] && [ ! -e "$R115_RUN" ] && grep -q ' RELEASED ' "$R115_LOG" \
          || { echo "  WRONG gate $mode：成功且 active 后未清责任"; exit 1; }
        if [ "$mode" = confirm-active ]; then
          [ ! -s "$FIX_CALLS" ] || { echo "  WRONG 已 active 时不应重新启动"; exit 1; }
        fi ;;
      blind)
        [ "$rc" = 0 ] && [ ! -s "$FIX_CALLS" ] && [ "$(cat "$R115_RUN")" = '1 1' ] && grep -q ' SKIP ' "$R115_LOG" \
          || { echo "  WRONG gate blind：缺指标时不能启动或丢失责任"; exit 1; } ;;
    esac
    echo "  OK   gate 离线执行 $mode（失败保留责任、恢复读回、重试与缺指标）"
  )
  for fixture in start-fails inactive start-fails-active readback-fails remove-fails confirm-remove-fails success confirm-active blind; do gate_fixture "$fixture" || exit 1; done
  ownership_fixture() (
    local mode="$1" rc=0
    export FIX_MODE="$mode" FIX_CALLS="$T/ownership-calls" FIX_WORKER="$T/ownership-worker" FIX_PERMS="$T/ownership-perms"
    export GEOHOT_BIN="$T/gate-bin" R114_ENVF="$T/gate-valve" R114_NGX="$T/ownership-access"
    export R115_RUN="$T/ownership-run" R115_LOG="$T/ownership-log" R115_DISARM="$T/gate-disarmed" R115_DRY=0
    export R115_BUDGET_ERR5XX=0 R115_E5_WINDOW_SEC=700 R115_COOLDOWN_MIN=30
    : > "$FIX_CALLS"; : > "$R115_LOG"; : > "$FIX_PERMS"; rm -f "$R115_RUN"
    echo active > "$FIX_WORKER"
    [ "$mode" != operator ] || echo inactive > "$FIX_WORKER"
    [ "$mode" != stop-fails-owned ] || printf '1 1\n' > "$R115_RUN"
    printf '1.1.1.1 - - [%s] "GET /geohot/ HTTP/1.1" 503 12 "-" "fixture"\n' \
      "$(LC_ALL=C date '+%d/%b/%Y:%H:%M:%S %z')" > "$R114_NGX"
    systemctl() {
      case "$*" in
        'is-active geohot-worker')
          cat "$FIX_WORKER"
          [ "$FIX_MODE" != initial-active-error ] || return 3
          [ "$(cat "$FIX_WORKER")" = active ] || return 3 ;;
        'stop geohot-worker')
          echo stop >> "$FIX_CALLS"
          # stop 前必须已持久化恢复责任；没有状态就模拟崩溃，绝不假装停成。
          [ "$(cut -d' ' -f2- "$R115_RUN" 2>/dev/null)" = '1 stop-pending' ] \
            || { echo 'MISSING_STOP_INTENT' >&2; return 98; }
          case "$(cat "$FIX_PERMS")" in "${R115_RUN}.tmp."*) : ;; *) return 97 ;; esac
          # Git Bash/NTFS 的 chmod 600 实测仍映成 644；Linux 上额外断言实际 mode。
          case "$(uname -s)" in MINGW*|MSYS*) : ;; *) [ "$(stat -c '%a' "$R115_RUN")" = 600 ] || return 97 ;; esac
          case "$FIX_MODE" in interrupt-pending-active) kill -TERM "$BASHPID"; return 99 ;;
            interrupt-pending-inactive) echo inactive > "$FIX_WORKER"; kill -TERM "$BASHPID"; return 99 ;; esac
          case "$FIX_MODE" in
            stop-fails|stop-fails-owned) return 1 ;;
            stop-fails-inactive) echo inactive > "$FIX_WORKER"; return 1 ;;
            stop-stays-active) return 0 ;;
            *) echo inactive > "$FIX_WORKER" ;;
          esac ;;
        'start geohot-worker') echo start >> "$FIX_CALLS"; echo active > "$FIX_WORKER" ;;
        *) echo "UNEXPECTED systemctl $*" >&2; return 99 ;;
      esac
    }
    export -f systemctl
    printf() {
      if [ "${1-}" = '%s 1 stop-pending\n' ]; then
        case "$FIX_MODE" in write-fails|write-fails-owned) return 1 ;; esac
      fi
      builtin printf "$@"
    }
    mv() {
      case "$FIX_MODE" in rename-fails|rename-fails-owned) return 1 ;; esac
      command mv "$@"
    }
    chmod() {
      [ "${1-}" != 600 ] || builtin printf '%s' "$2" > "$FIX_PERMS"
      command chmod "$@"
    }
    export -f printf mv chmod
    case "$mode" in write-fails-owned|rename-fails-owned) builtin printf '1 1\n' > "$R115_RUN" ;; esac
    bash "$T/gate.sh" || rc=$?
    case "$mode" in
      operator|initial-active-error)
        [ "$rc" = 0 ] && [ ! -e "$R115_RUN" ] && [ ! -s "$FIX_CALLS" ] \
          || { echo "  WRONG operator 红指标后被认领或操作"; exit 1; } ;;
      write-fails|write-fails-owned|rename-fails|rename-fails-owned)
        [ "$rc" -ne 0 ] && [ ! -s "$FIX_CALLS" ] && [ "$(cat "$FIX_WORKER")" = active ] \
          || { echo "  WRONG $mode 意图提交失败仍执行 stop"; cat "$R115_LOG"; exit 1; }
        case "$mode" in
          *-owned) [ "$(cat "$R115_RUN")" = '1 1' ] || { echo "  WRONG 写失败损坏原状态"; exit 1; } ;;
          *) [ ! -e "$R115_RUN" ] || { echo "  WRONG 提交失败留下不完整状态"; exit 1; } ;;
        esac
        echo "  OK   gate 意图 $mode（提交失败零 stop、原状态保持）"; exit 0 ;;
      stop-fails|stop-fails-inactive|stop-stays-active|stop-fails-owned|interrupt-pending-active|interrupt-pending-inactive)
        [ "$rc" -ne 0 ] && ! grep -q ' TRIPPED ' "$R115_LOG" \
          || { echo "  WRONG $mode 停止失败却报成功"; cat "$R115_LOG"; exit 1; }
        [ "$(cut -d' ' -f2- "$R115_RUN" 2>/dev/null)" = '1 stop-pending' ] \
          || { echo "  WRONG $mode 意图丢失，worker 无人负责恢复"; cat "$R115_LOG"; exit 1; } ;;
      trip-success)
        [ "$rc" = 0 ] && [ "$(cut -d' ' -f2 "$R115_RUN")" = 1 ] && grep -q ' TRIPPED ' "$R115_LOG" \
          || { echo "  WRONG stop 成功且 inactive 后未持有责任"; exit 1; } ;;
    esac
    # 红 → 冷却期绿 → 冷却结束绿；operator 始终不归闸门负责，成功停下的才自动恢复。
    sed 's/ 503 / 200 /' "$R114_NGX" > "$T/ownership-green"
    cp "$T/ownership-green" "$R114_NGX"
    bash "$T/gate.sh" || exit 1
    if [ "$mode" != operator ] && [ "$mode" != initial-active-error ]; then
      ! grep -q '^start$' "$FIX_CALLS" && [ -e "$R115_RUN" ] || { echo "  WRONG 冷却期提前恢复"; exit 1; }
      builtin printf '1 1 stop-pending\n' > "$R115_RUN"
    fi
    bash "$T/gate.sh" || exit 1
    [ ! -e "$R115_RUN" ] || { echo "  WRONG 绿灯到期后责任未收口"; exit 1; }
    if [ "$mode" = operator ] || [ "$mode" = initial-active-error ]; then
      [ ! -s "$FIX_CALLS" ] || { echo "  WRONG 非闸门责任跨轮被自动启动"; exit 1; }
    elif [ "$(grep -c '^stop$' "$FIX_CALLS")" = 1 ] && [ "$(cat "$FIX_WORKER")" = active ] \
      && { [ "$mode" = stop-fails ] || [ "$mode" = stop-fails-owned ] || [ "$mode" = stop-stays-active ] || [ "$mode" = interrupt-pending-active ]; }; then
      ! grep -q '^start$' "$FIX_CALLS" || { echo "  WRONG 已 active 的 pending 重复启动"; exit 1; }
    else
      [ "$(grep -c '^start$' "$FIX_CALLS")" = 1 ] && [ "$(cat "$FIX_WORKER")" = active ] || { echo "  WRONG 持有责任后未正确恢复"; exit 1; }
    fi
    echo "  OK   gate 所有权 $mode（红→冷却→绿跨轮）"
  )
  for fixture in operator initial-active-error write-fails write-fails-owned rename-fails rename-fails-owned stop-fails stop-fails-inactive stop-stays-active stop-fails-owned interrupt-pending-active interrupt-pending-inactive trip-success; do ownership_fixture "$fixture" || exit 1; done
  grep -q 'R115_DRY' "$T/gate.sh" && echo "  OK   闸门带 DRY 分支（真机上要先只判不动地试跑一次）" || { echo "  WRONG 闸门没有 DRY 分支"; exit 1; }
  grep -q 'FATAL 判据文件缺 gate_action' "$T/gate.sh" \
    && echo "  OK   判据文件缺函数时闸门硬失败（18:53 那次就是安静失效：只留一行 command not found，什么也不做）" || { echo "  WRONG 闸门在判据缺失时会安静失效"; exit 1; }
  unit_gate_svc 700 30 "$BIN/r115-reader-gate.sh" > "$T/gate.service"
  grep -q '^ExecStart=/bin/bash /opt/geohot/bin/r115-reader-gate.sh$' "$T/gate.service" \
    && grep -q 'Environment=R115_COOLDOWN_MIN=30' "$T/gate.service" \
    && echo "  OK   闸门单元 ExecStart 指向脚本、冷却时长走 Environment=" || { echo "  WRONG 闸门单元形状不对：$(grep '^ExecStart' "$T/gate.service")"; exit 1; }
  # 与旧写法做**差分**：同一组输入必须给出不同答案，否则这条修复根本没落地。
  legacy_decide() { local left="${1:-0}"; if [ "$left" -le -1 ]; then echo "HOLD|unknown_left"; return; fi; if [ "${3:-0}" -gt 0 ]; then echo "RESTORE|reader_5xx=$3"; return; fi; echo "HOLD|legacy"; }
  [ "$(legacy_decide -1 300 5)" = "HOLD|unknown_left" ] && [ "$(decide -1 300 5 1000 2000 1 0 0)" != "HOLD|unknown_left" ] \
    && echo "  OK   差分对照：旧判据在这组输入下说 HOLD（正是要修的），新判据说 $(decide -1 300 5 1000 2000 1 0 0)" \
    || { echo "  WRONG 新旧判据没测出差别 —— 要么顺序没真改，要么夹具在骗人"; exit 1; }
  if ( chk "故意给错的期望" HOLD -1 300 5 1000 2000 1 0 0 ) >/dev/null 2>&1; then
    echo "  WRONG 断言器失效：故意写错的期望也该红"; exit 1
  else
    echo "  OK   EXPECTED_RED：故意写错的期望确实被拒（证明上面那一串 OK 不是永远绿的）"
  fi
  unit_tm geohot-r114-drain-watch "d" "$CADENCE" > "$T/watch.timer"
  [ "$CADENCE" = "*:00/10" ] && grep -q 'OnCalendar=\*:00/10' "$T/watch.timer" \
    && echo "  OK   哨兵每 10 分钟问一次（30 分钟太慢：今天那阵 5xx 会白占半小时实时）" || { echo "  WRONG 哨兵节奏不是 10 分钟（现在是 $CADENCE）"; exit 1; }
  grep -qE 'e5_count "\$\{R114_NGX' "$T/watch.sh" \
    && echo "  OK   哨兵用的是判据文件里那一份 e5_count（测的与跑的是同一把尺）" || { echo "  WRONG 哨兵没调共享的 e5_count，尺被另抄了一份"; exit 1; }
  # 归档周期的节律要跟着窗口走：白天按住（17:30 那一轮跑 28 分钟未完，与读者面 5xx 撞在同一区间），夜里放行。
  grep -q 'systemctl stop geohot-archive.timer' "$T/watch.sh" \
    && echo "  OK   哨兵撤窗后把归档周期按回白天静默（reverter 会顺手 start，这一句必须在它后面）" || { echo "  WRONG 撤窗后白天又开始跑归档周期"; exit 1; }
  grep -q 'ARCHIVE_ON_IN_WINDOW' "$0" \
    && echo "  OK   --start 在关阀之后放行归档周期（窗口里才是它该扫片与出刊的时候）" || { echo "  WRONG --start 没放行归档周期，夜里没供给"; exit 1; }
  # 顺序也要判：关阀那半（114 stop.sh）自己会 stop 本定时器，放行必须跑在它后面，否则等于没放行。
  # 只在 --start..--restore 之间找：直接 grep "$0" 会先命中本 selftest 自己这两行（连着红过两次，都是量具在骗人）。
  START_BLK=$(awk '/^--start\)/{f=1} /^--restore\)/{f=0} f' "$0")
  ARCH_LN=$(printf '%s\n' "$START_BLK" | grep -n 'echo "ARCHIVE_ON_IN_WINDOW rc=' | cut -d: -f1 | head -1)
  STOP_LN=$(printf '%s\n' "$START_BLK" | grep -n 'R114_FORCE=1 bash "$STOPPER"; rc' | cut -d: -f1 | head -1)
  { [ -n "$ARCH_LN" ] && [ -n "$STOP_LN" ] && [ "$ARCH_LN" -gt "$STOP_LN" ]; } \
    && echo "  OK   放行归档跑在关阀之后（第 $STOP_LN 行关阀 → 第 $ARCH_LN 行放行）" \
    || { echo "  WRONG 放行没跑在关阀之后（关阀=$STOP_LN 放行=$ARCH_LN），会被 stop.sh 抵消"; exit 1; }
  grep -q 'WantedBy=timers.target' "$T/watch.timer" && echo "  OK   哨兵 timer 带 [Install]（enable 得动）" || { echo "  WRONG timer 缺 [Install]"; exit 1; }
  grep -q 'Persistent=false' "$T/watch.timer" && echo "  OK   Persistent=false（错过一轮不补跑）" || { echo "  WRONG 哨兵会补跑"; exit 1; }
  unit_svc geohot-r114-drain-watch "d" 1700000000 60 0 3 6 4 2400 34200 "$BIN/x.sh" > "$T/watch.service"
  grep -q 'Environment=R114_DEADLINE_EPOCH=' "$T/watch.service" && echo "  OK   期限与两个阈值经 Environment= 传进单元（不写死在脚本里）" || { echo "  WRONG 单元没带阈值"; exit 1; }
  grep -q 'Environment=R114_BLIND_STREAK=4' "$T/watch.service" && grep -q 'Environment=R114_E5_WINDOW_SEC=2400' "$T/watch.service" \
    && echo "  OK   看不见阈值与 5xx 窗口也走 Environment=（改这两个不用重编脚本）" || { echo "  WRONG 单元没带 blind/5xx 窗口"; exit 1; }
  grep -q 'Environment=R114_MAX_WINDOW_SEC=34200' "$T/watch.service" \
    && echo "  OK   单窗上限也走 Environment=（不在脚本里写死）" || { echo "  WRONG 上限没进单元"; exit 1; }
  # 本轮真踩的坑：unit_svc 多加一个参数而模板没跟上，ExecStart 就变成 `/bin/bash 34200`（把秒数当脚本跑），
  # 21:00 那一枪会静默失败——今晚既不开窗也不放行归档。断言只认"以 .sh 结尾"这个形状。
  EXW=$(grep '^ExecStart=' "$T/watch.service" | sed 's|^ExecStart=/bin/bash ||')
  case "$EXW" in
    *.sh) echo "  OK   哨兵 ExecStart 指向脚本 [$EXW]" ;;
    *) echo "  WRONG 哨兵 ExecStart 不是脚本而是 [$EXW] —— 参数个数与模板对不上"; exit 1 ;;
  esac
  unit_svc geohot-r114-longwindow-start "d" 1700000000 60 0 3 6 4 2400 34200 "/opt/geohot/app/deploy/geohot/night-window/install-long-window.sh --start" > "$T/night.service"
  grep -q '^ExecStart=/bin/bash /opt/geohot/app/deploy/geohot/night-window/install-long-window.sh --start$' "$T/night.service" \
    && echo "  OK   晚间单元跑的是仓库副本且带 --start" || { echo "  WRONG 晚间单元 ExecStart 形状不对：[$(grep '^ExecStart=' "$T/night.service")]"; exit 1; }
  # 21:00 那一枪今天静悄悄没响（service 全天零痕迹），而 Persistent=false 让"错过"变成"今晚没了"。
  # 开窗那枚与哨兵那两枚的语义正好相反，所以要分开钉：错过的夜晚必须补，错过的十分钟不许补。
  [ "$(unit_tm x d '*-*-* 21:00:00' true | grep -c '^Persistent=true$')" = 1 ] \
    && [ "$(unit_tm x d '*-*-* 21:00:00' | grep -c '^Persistent=false$')" = 1 ] \
    && echo "  OK   unit_tm 第 4 个参数：开窗那枚可要 Persistent=true，哨兵/闸门仍默认 false" \
    || { echo "  WRONG Persistent 参数没生效（错过一次开窗就少一整夜）"; exit 1; }
  NIGHT_BLK=$(awk '/^--arm-nightly\)/{f=1} /^--disarm-nightly\)/{f=0} f' "$0")
  printf '%s\n' "$NIGHT_BLK" | grep -qF '"*-*-* $NIGHT:00:00" true > "$SYS/geohot-r114-longwindow-start.timer"' \
    && echo "  OK   --arm-nightly 生成的那枚 timer 确实带着 true（不是只改了函数、调用点没跟上）" \
    || { echo "  WRONG --arm-nightly 还在生成 Persistent=false 的开窗定时器"; exit 1; }
  # —— Persistent=true 换来的"错过的夜晚要补跑"必须被时刻闸兜住，否则补跑会落在白天（对抗代理的 BLOCKER）。
  NIGHT_HITS=""; NIGHT_MISS=""
  for h in 21 22 23 00 01 02 03 04 05; do night_ok "$h" || NIGHT_HITS="$NIGHT_HITS $h"; done
  for h in 06 07 08 12 16 17 18 19 20 0600 ""; do night_ok "$h" && NIGHT_MISS="$NIGHT_MISS $h"; done
  [ -z "$NIGHT_HITS" ] && [ -z "$NIGHT_MISS" ] \
    && echo "  OK   night_ok 真值表：21—05 全放行、06/07/08/12/16/17/18/19/20 与空串全拒绝" \
    || { echo "  WRONG night_ok 时刻闸不对（该放没放=[$NIGHT_HITS] 该拒没拒=[$NIGHT_MISS]）"; exit 1; }
  printf '%s\n' "$START_BLK" | grep -q 'REFUSE_DAYLIGHT' \
    && echo "  OK   --start 真的接了时刻闸，拒绝时出声且 exit 0（不让 journald 留一条假事故）" \
    || { echo "  WRONG --start 没接时刻闸：Persistent 补跑能在白天把实时关掉"; exit 1; }
  printf '%s\n' "$START_BLK" | grep -q 'R114_ANY_HOUR' \
    && echo "  OK   白天人工授权留了显式入口（R114_ANY_HOUR=1），不是让人去改脚本" \
    || { echo "  WRONG 白天没有合法入口，绕路只能徒手改脚本"; exit 1; }
  WATCH_BLK=$(awk '/^watch_body\(\)/{f=1} /^gate_body\(\)/{f=0} f' "$0")
  printf '%s\n' "$WATCH_BLK" | grep -q 'cat /run/geohot-r114-opened' \
    && printf '%s\n' "$START_BLK" | grep -q 'date +%s > /run/geohot-r114-opened' \
    && echo "  OK   单窗上限有第二把锚：旗标读不到时退到 /run 那份（M5：不然上限会静默消失）" \
    || { echo "  WRONG 开窗时刻只有旗标一把尺，旗标坏了就没上限"; exit 1; }
  printf '%s\n' "$START_BLK" | grep -q 'WINDOW_ALREADY_OPEN' \
    && echo "  OK   窗口已开时 --start 会跳过（21:00 那一枪不会在 journald 留 exit 1 的假事故）" || { echo "  WRONG --start 不幂等"; exit 1; }
  echo "  INFO 本次阈值：内存地板 ${FLOOR} MB（连击 ${STREAK_N} 次）∶ 5xx 预算 ${BUDGET} 条（最近 ${E5WIN} s 锚时刻）∶ 停摆 ${STALL_N} 轮（=3 小时零判完才撤窗，存量涨不算停摆）∶ 看不见 ${BLIND_N} 轮∶ 期限 epoch $DEADLINE_EPOCH"
  [ "$DEADLINE_EPOCH" -gt "$(date +%s)" ] || echo "  NOTE 期限不在将来 —— --start 会拒绝这个值"
  echo SELFTEST_OK
  ;;
--start)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  # 幂等：窗口已经开着（阀 false 且哨兵 armed）时，晚间定时器再打一枪应当什么都不做，
  # 而不是撞"阀门现值不是 true"这道门、在 journald 里留一条 exit 1 让人误以为今晚没开窗。
  if [ "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" = "COLLECT_ENABLED=false" ] \
     && [ "$(systemctl is-enabled geohot-r114-drain-watch.timer 2>/dev/null)" = "enabled" ]; then
    echo "WINDOW_ALREADY_OPEN 阀已关、哨兵已 armed —— 这一枪跳过，窗口继续按同一条判据跑"
    exit 0
  fi
  [ "$DEADLINE_EPOCH" -gt "$(date +%s)" ] || { echo "REFUSE 最迟期限 epoch=$DEADLINE_EPOCH 不在将来（R114_DEADLINE_EPOCH 给错了）"; exit 1; }
  if [ "${R114_ANY_HOUR:-0}" != 1 ] && ! night_ok "$(date +%H)"; then
    echo "REFUSE_DAYLIGHT 此刻 $(date +%H) 点不在许可时段（21:00—05:59）——这一枪跳过，阀门一个字节没动"
    echo "  为什么：开窗那枚 timer 是 Persistent=true，开机补跑不看时刻；白天开一扇实测 57 条 5xx／首页 15.3 s。"
    echo "  真要在白天开（人工授权）：R114_ANY_HOUR=1 bash $0 --start"
    exit 0
  fi
  bash "$0" --selftest || { echo "REFUSE 自测不过，不装也不关阀"; exit 1; }
  [ -x "$STOPPER" ] && [ -x "$REVERTER" ] || { echo "REFUSE 关阀/恢复两半不在 $BIN（先跑 install-night-window.sh --install）"; exit 1; }
  case "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" in
    COLLECT_ENABLED=true) : ;;
    *) echo "REFUSE 阀门现值不是 true：$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")（只从'正在实时'进窗口）"; exit 1;;
  esac
  install_files
  # 上一轮窗口留下的两个计数器不能带进这一轮：拿旧存量比今天的第一次读数，会凭空记上一笔"停摆"。
  rm -f /run/geohot-r114-lowmem /run/geohot-r114-left 2>/dev/null
  systemd-analyze calendar "$CADENCE" | head -2
  systemctl enable --now geohot-r114-drain-watch.timer || { echo "REFUSE 哨兵 enable 失败，阀门不动"; exit 1; }
  # 出门前先留第二条回家的路：天亮那半（05:30）是 114 轮的独立定时器，它跑完会自拆，所以每晚在这里重新拧上。
  # 哨兵自己的 9.5 小时上限是第三条路——万一这两把 systemd 定时器都没跑成。
  if [ -e "$SYS/geohot-r114-restore.timer" ]; then
    systemctl enable --now geohot-r114-restore.timer 2>/dev/null \
      && echo "MORNING_BACKSTOP=geohot-r114-restore.timer $(systemctl is-enabled geohot-r114-restore.timer 2>&1)/$(systemctl is-active geohot-r114-restore.timer 2>&1)" \
      || echo "NOTE 天亮兜底 enable 失败（哨兵的 9.5 小时上限仍在，不阻塞开窗）"
  else
    echo "NOTE 机上没有 geohot-r114-restore.timer：只剩哨兵一条回程，仍可开窗（上限 9.5 小时）"
  fi
  echo "SENTINEL_ARMED $(systemctl is-enabled geohot-r114-drain-watch.timer)/$(systemctl is-active geohot-r114-drain-watch.timer)"
  R114_FORCE=1 bash "$STOPPER"; rc=$?
  echo "STOP_RC=$rc"
  [ "$rc" = 0 ] || { echo "关阀退 $rc：哨兵已装但窗口没开，请人工看 $LOG；现值 $(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")"; exit 1; }
  # 第二条"开窗时刻"账：旗标 mtime 是主尺，这份 /run 是备尺（见上面 OPENED 那条注释）。写失败不影响窗口，只少一把备尺，所以要出声。
  date +%s > /run/geohot-r114-opened 2>/dev/null \
    && echo "OPENED_ANCHOR /run/geohot-r114-opened=$(cat /run/geohot-r114-opened)" \
    || echo "NOTE 备尺写不进 /run（主尺仍靠 $(date -r /etc/geohot/r114-stop.done +%s 2>/dev/null || echo 读不到) 的 mtime）"
  # 窗口里要让归档周期跑：它那两轮活（扫片 supply + 判完的日子出刊）只有它会干，白天停着就是为了避开读者，
  # 夜里正是它该干活的时候。114 那半 stop.sh 会顺手 stop 掉本定时器，所以这一句必须跑在它后面。
  systemctl start geohot-archive.timer
  ARC_RC=$?
  echo "ARCHIVE_ON_IN_WINDOW rc=$ARC_RC active=$(systemctl is-active geohot-archive.timer 2>&1)"
  printf 'valve=%s worker=%s archive_timer=%s watch=%s\n' "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)" "$(systemctl is-active geohot-r114-drain-watch.timer)"
  echo "LONG_WINDOW_OPEN 剩余存量由哨兵每 10 分钟读一次：5xx→低内存→停摆→看不见→单窗上限→期限→排空 都恢复"
  ;;
--arm-nightly)
  # 每晚 21:00 自己开一扇（低峰时段独占），天亮前由哨兵/兜底定时器收口。
  # 为什么不再白天开：17:00—17:45 那一扇实测把读者面打进 503/504（一小时 57 条，首页 15.3 s 超时），
  # 同一条判据夜里跑了整晚是 0 条 5xx／890 请求——差别不在判据，在读者量。
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$0" --selftest >/dev/null || { echo "REFUSE 自测不过，不排今晚"; exit 1; }
  DIST=${R114_DIST:-/opt/geohot/app/deploy/geohot/night-window/install-long-window.sh}
  [ -f "$DIST" ] || { echo "REFUSE 仓库副本不在 $DIST —— 定时器要调它，先用发布船投放"; exit 1; }
  NIGHT=${R114_NIGHT_HOUR:-21}
  install_files
  unit_svc geohot-r114-longwindow-start "GEOHOT long-window nightly open ($NIGHT:00)" "$DEADLINE_EPOCH" "$FLOOR" "$BUDGET" "$STREAK_N" "$STALL_N" "$BLIND_N" "$E5WIN" "$MAXSEC" "$DIST --start" > "$SYS/geohot-r114-longwindow-start.service"
  unit_tm  geohot-r114-longwindow-start "GEOHOT long-window nightly open" "*-*-* $NIGHT:00:00" true > "$SYS/geohot-r114-longwindow-start.timer"
  systemctl daemon-reload
  systemd-analyze calendar "*-*-* $NIGHT:00:00" | head -2
  systemctl enable --now geohot-r114-longwindow-start.timer || { echo "REFUSE 今晚这扇排不上（enable 失败），阀门没动"; exit 1; }
  # 排上今晚这扇之后，白天这一段立刻按住归档周期（依据：17:30 那一轮跑了 28 分钟未完，与读者面 5xx 撞在同一区间）
  systemctl stop geohot-archive.timer 2>/dev/null
  echo "DAY_ARCHIVE=paused active=$(systemctl is-active geohot-archive.timer 2>&1) —— 今晚 $NIGHT:00 由 --start 放行归档周期"
  printf 'nightly=%s/%s watch=%s/%s valve=%s\n' \
    "$(systemctl is-enabled geohot-r114-longwindow-start.timer 2>&1)" "$(systemctl is-active geohot-r114-longwindow-start.timer 2>&1)" \
    "$(systemctl is-enabled geohot-r114-drain-watch.timer 2>&1)" "$(systemctl is-active geohot-r114-drain-watch.timer 2>&1)" \
    "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")"
  [ "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" = "COLLECT_ENABLED=true" ] || echo "  NOTE 阀门现在不是 true：今晚 21:00 的 --start 会自己拒绝开窗（只从'正在实时'进窗口）"
  echo "NIGHTLY_ARMED 每晚 $NIGHT:00 开窗，哨兵每 $CADENCE 问一次去留"
  ;;
--disarm-nightly)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  systemctl disable --now geohot-r114-longwindow-start.timer 2>/dev/null
  # 政策撤了就把归档周期交回日常节律（这才是这台机一直以来的常态）
  systemctl start geohot-archive.timer 2>/dev/null
  printf 'nightly=%s/%s archive_timer=%s valve=%s worker=%s\n' "$(systemctl is-enabled geohot-r114-longwindow-start.timer 2>&1)" \
    "$(systemctl is-active geohot-r114-longwindow-start.timer 2>&1)" "$(systemctl is-active geohot-archive.timer 2>&1)" \
    "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" "$(systemctl is-active geohot-worker)"
  echo NIGHTLY_DISARMED
  ;;
--gate-on)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$0" --selftest >/dev/null || { echo "REFUSE 自测不过，不装闸门"; exit 1; }
  # 闸门靠 source 判据文件里的 gate_action／e5_count；只装闸门不重落判据 = 装了个每 10 分钟报 command not found 的死人。
  install_files
  install_gate
  declare -F gate_action >/dev/null; [ -f "$DECIDE" ] && grep -q 'gate_action()' "$DECIDE" \
    && echo "  OK   判据文件已含 gate_action（闸门与哨兵共用这一份）" || { echo "  WRONG 判据文件里没有 gate_action，闸门会是安静失效的死人"; exit 1; }
  systemd-analyze calendar "$GATE_CADENCE" | head -2
  systemctl enable --now geohot-r115-reader-gate.timer || { echo "REFUSE 闸门定时器 enable 失败"; exit 1; }
  printf 'gate=%s/%s worker=%s cooldown=%s 分钟 5xx 窗=%s 秒\n' \
    "$(systemctl is-enabled geohot-r115-reader-gate.timer 2>&1)" "$(systemctl is-active geohot-r115-reader-gate.timer 2>&1)" \
    "$(systemctl is-active geohot-worker)" "$COOLDOWN" "$E5WIN"
  echo "READER_GATE_ON 读者的路一红就按停 geohot-worker（判定腿＋翻译腿），冷却 $COOLDOWN 分钟后自动起回"
  ;;
--gate-off)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  systemctl disable --now geohot-r115-reader-gate.timer 2>/dev/null
  # 闸门停过 worker 就得负责起回来——不能"撤闸门"顺手留下一个停着的引擎。
  WE=$(cut -d' ' -f2 "${R115_RUN:-/run/geohot-r115-gate}" 2>/dev/null || echo 0)
  if [ "${WE:-0}" = 1 ]; then systemctl start geohot-worker 2>/dev/null; ACT=已交回; else ACT=本就没停过; fi
  rm -f "${R115_RUN:-/run/geohot-r115-gate}" 2>/dev/null
  printf 'gate=%s/%s worker=%s（%s）\n' "$(systemctl is-enabled geohot-r115-reader-gate.timer 2>&1)" \
    "$(systemctl is-active geohot-r115-reader-gate.timer 2>&1)" "$(systemctl is-active geohot-worker)" "$ACT"
  echo GATE_OFF
  ;;
--gate-status|--gate-trial)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  printf 'gate=%s/%s worker=%s valve=%s 状态文件=[%s]\n' "$(systemctl is-enabled geohot-r115-reader-gate.timer 2>&1)" \
    "$(systemctl is-active geohot-r115-reader-gate.timer 2>&1)" "$(systemctl is-active geohot-worker)" \
    "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" "$(cat /run/geohot-r115-gate 2>/dev/null)"
  if [ "$MODE" = "--gate-trial" ]; then
    # 真机试跑：DRY 模式——只做判定与打日志，绝不停/起任何单元。
    R115_DRY=1 bash "${R115_GATE_SCRIPT:-$BIN/r115-reader-gate.sh}"; echo "TRIAL_RC=$?"
  fi
  tail -4 /var/log/geohot-r115-readergate.log 2>/dev/null || echo "  （还没有闸门日志）"
  ;;
--restore)
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  R114_FORCE=1 bash "$REVERTER"; rc=$?
  systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
  systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
  # 夜窗政策还在生效（晚间定时器仍 enabled）⇒ 白天这一段继续按住归档周期；政策已撤则交回日常节律。
  NIGHT_ON=$(systemctl is-enabled geohot-r114-longwindow-start.timer 2>/dev/null || echo unknown)
  if [ "$NIGHT_ON" = "enabled" ]; then
    systemctl stop geohot-archive.timer 2>/dev/null
    echo "DAY_ARCHIVE=paused（夜窗政策仍生效，21:00 由 --start 放行归档周期）"
  else
    echo "DAY_ARCHIVE=normal（晚间定时器=$NIGHT_ON，归档周期按日常节律跑）"
  fi
  printf 'RESTORE_RC=%s valve=%s worker=%s archive_timer=%s\n' "$rc" "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)"
  ;;
--refresh)
  # 窗口开着的时候改判据走这条路：只重落脚本与单元，绝不碰阀门、绝不 enable（--start 才有那个门槛）。
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$0" --selftest || { echo "REFUSE 自测不过，不落盘"; exit 1; }
  install_files
  printf 'watch=%s/%s valve=%s（refresh 不该改这两个）\n' "$(systemctl is-enabled geohot-r114-drain-watch.timer 2>&1)" \
    "$(systemctl is-active geohot-r114-drain-watch.timer 2>&1)" "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")"
  echo REFRESH_DONE
  ;;
--once)
  # 手工走一轮生产脚本（与定时器那一次完全同一条代码路径）：排空了它就会当场恢复，这是特性不是副作用。
  [ "$(id -u)" = 0 ] || { echo "REFUSE 需要 root"; exit 1; }
  bash "$WATCH"; echo "ONCE_RC=$?"
  tail -3 "$LOG"
  ;;
--status)
  printf 'valve=%s worker=%s archive_timer=%s reprint=%s watch=%s/%s nightly=%s/%s\n' "$(grep -m1 -E '^COLLECT_ENABLED=' "$ENVF")" \
    "$(systemctl is-active geohot-worker)" "$(systemctl is-active geohot-archive.timer)" \
    "$(systemctl is-active geohot-reprint-today.timer)" \
    "$(systemctl is-enabled geohot-r114-drain-watch.timer 2>&1)" "$(systemctl is-active geohot-r114-drain-watch.timer 2>&1)" \
    "$(systemctl is-enabled geohot-r114-longwindow-start.timer 2>&1)" "$(systemctl is-active geohot-r114-longwindow-start.timer 2>&1)"
  echo "最近几次判定（尺就是生产那一份，不另抄）："
  tail -8 "$LOG" 2>/dev/null || echo "（还没有长窗口日志）"
  ;;
*) echo "用法: $0 --selftest|--start|--arm-nightly|--disarm-nightly|--gate-on|--gate-off|--gate-status|--gate-trial|--refresh|--once|--restore|--status"; exit 2;;
esac
