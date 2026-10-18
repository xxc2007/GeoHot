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
# 期限为什么定在 2026-10-24 06:00：17:07 现读要干 16,268 件（判 14,692 ∶ 翻 1,576），判定 ≈178 件/时、翻译 ≈43 篇/时，
# 且翻译量会随判定推进继续长出（档案带精选产出率 ≈20% ⇒ 还要再翻 ≈2,900 篇）⇒ 投影 ≈4.5 天，留一天余量。
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
DL_DEFAULT=$(date -d "2026-10-24 06:00:00" +%s 2>/dev/null || echo 0)
DEADLINE_EPOCH=${R114_DEADLINE_EPOCH:-$DL_DEFAULT}
FLOOR=${R114_FLOOR_AVAIL_MB:-60}
BUDGET=${R114_BUDGET_ERR5XX:-0}
STREAK_N=${R114_LOWMEM_STREAK:-3}
STALL_N=${R114_STALL_STREAK:-18}
BLIND_N=${R114_BLIND_STREAK:-3}
E5WIN=${R114_E5_WINDOW_SEC:-700}
MAXSEC=${R114_MAX_WINDOW_SEC:-34200}
CADENCE=${R114_WATCH_CADENCE:-"*:00/10"}

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
#             GEOHOT_STALL_STREAK（停摆要连续几次才撤，默认 18 = 3 小时，每 10 分钟一次）
#             GEOHOT_BLIND_STREAK（看不见要连续几次才撤，默认 3 = 30 分钟：瞎着的哨兵不如开实时）
#             GEOHOT_MAX_WINDOW_SEC（单窗上限，默认 34200 = 9.5 小时：天亮前必须让回实时，不靠另一半天亮定时器）
decide() {
  local left="${1:-0}" avail="${2:-0}" e5="${3:-0}" now="${4:-0}" deadline="${5:-0}" streak="${6:-1}" stalled="${7:-0}" blind="${8:-0}" opened="${9:-0}"
  local floor="${GEOHOT_FLOOR_AVAIL_MB:-60}" budget="${GEOHOT_BUDGET_ERR5XX:-0}" need="${GEOHOT_LOWMEM_STREAK:-3}"
  local stallneed="${GEOHOT_STALL_STREAK:-18}" blindneed="${GEOHOT_BLIND_STREAK:-3}" maxsec="${GEOHOT_MAX_WINDOW_SEC:-34200}"
  # 顺序要紧：读者的命、内存、停摆、看不见、期限，全都排在"读不到存量"之前。
  # 17:34—17:36 那两条 HOLD|unknown_left 里就藏着 err5xx=30/45 —— 旧写法把 unknown_left 顶在第一行，
  # 量具一坏就把 5xx/低内存/期限三条保命规则一起屏蔽了，这是这类哨兵最危险的失效模式。
  if [ "$e5" -gt "$budget" ]; then echo "RESTORE|reader_5xx=$e5"; return; fi
  if [ "$avail" -lt "$floor" ]; then
    if [ "$streak" -ge "$need" ]; then echo "RESTORE|low_mem=${avail}MB streak=$streak"; return; fi
    echo "HOLD|low_mem=${avail}MB streak=$streak/$need"; return
  fi
  # 停摆放在期限之前：先恢复实时（站点继续活着），而不是干等到死期限再恢复。
  if [ "$stalled" -ge "$stallneed" ]; then echo "RESTORE|stalled=${stalled}轮_存量未降"; return; fi
  if [ "$blind" -ge "$blindneed" ]; then echo "RESTORE|gauge_blind=${blind}轮读不到量具"; return; fi
  # 单窗上限（默认 9.5 小时）：夜里那一扇就算没排空也该在天亮前让回实时，
  # 万一 05:30 那半恢复单元没跑成（它是机器侧的另一条路，不是这里的责任），这条自己会收口。
  if [ "$opened" -gt 0 ] && [ "$maxsec" -gt 0 ] && [ $(( now - opened )) -ge "$maxsec" ]; then
    echo "RESTORE|max_window=$(( (now - opened) / 60 ))min"; return
  fi
  if [ "$deadline" -gt 0 ] && [ "$now" -ge "$deadline" ]; then echo "RESTORE|deadline"; return; fi
  # 读不到存量 = -1，绝不能当成"排空了"；但也不能拿它当"继续开"的理由一直压着——blind 那条已经在管它。
  if [ "$left" -le -1 ]; then echo "HOLD|unknown_left"; return; fi
  if [ "$left" -le 0 ]; then echo "RESTORE|drained"; return; fi
  echo "HOLD|left=$left avail=${avail}MB e5=$e5 stalled=$stalled/$stallneed"
}
# 停摆计数：需要**上次的存量**和**上次的计数**两个输入——只给存量就会把存量本身当计数加一（我第一版就是这么错的）。
#   $1 上次存量（空=第一轮）  $2 上次计数  $3 本次存量
next_stall() {
  local prev="${1-}" cnt="${2-0}" now="${3-}"
  case "$cnt" in ''|*[!0-9]*) cnt=0 ;; esac
  case "$prev" in ''|*[!0-9]*) echo 0; return ;; esac
  # 本次读不到存量：计数**保持不动**——既不 +1（一次 psql 抖动不该往撤窗走），也不归零（那会掩盖真停摆）。
  case "$now" in ''|*[!0-9]*) echo "$cnt"; return ;; esac
  if [ "$now" -lt "$prev" ]; then echo 0; else echo $(( cnt + 1 )); fi
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
# "看不见"计数：存量或读者面 5xx 任一读数拿不到合法数字就 +1，两个都好则归零。
# 为什么要单独一条：17:34—17:36 连续两轮 psql 读空（存量=-1），那时哨兵既不知道排没排空、也不知道读者好不好，
# 却还在说 HOLD —— 一个看不见读者的哨兵没有资格替站长把实时按着。
#   $1 上次计数  $2 合计存量（-1 或非数字=读不到）  $3 近窗 5xx 条数（空或非数字=读不到）
next_blind() {
  local prev="${1-0}" left="${2-}" e5="${3-}"
  case "$prev" in ''|*[!0-9]*) prev=0 ;; esac
  case "$left" in ''|*[!0-9]*) echo $(( prev + 1 )); return ;; esac
  if [ "$left" -le -1 ]; then echo $(( prev + 1 )); return; fi
  case "$e5" in ''|*[!0-9]*) echo $(( prev + 1 )); return ;; esac
  echo 0
}
# 读者面 5xx 按**时刻**锚，不按"尾读 N 行"：旧尺数的是"今天之内、且落在最后 4000 行里"，而 4000 行覆盖多长
# 会随流量伸缩（17:24 读到 0、17:34 读到 30、17:36 读到 45 那种两义读数就是这么来的）。
# 字段偏移：$4 = "[18/Oct/2026:17:41:27"，日期占 2—12、冒号在 13，所以小时从 **14** 起（用 13 会把小时读成 0，
# 窗口过滤器于是永远数不到东西——17:44 我自己就栽过一次，这条由 selftest 的夹具钉住）。
#   $1 日志  $2 尾读行数  $3 窗口秒  $4 今天前缀(18/Oct/2026)  $5 今晨 epoch  $6 现在 epoch
e5_count() {
  tail -n "$2" "$1" 2>/dev/null | awk -v d="$4" -v t0="$5" -v now="$6" -v w="$3" \
    'index($4, "[" d ":")==1 {
       n++; if (first=="") first=substr($4,14,5); last=substr($4,14,5)
       hh=substr($4,14,2)+0; mi=substr($4,17,2)+0; ss=substr($4,20,2)+0
       if (t0>0 && now-(t0+hh*3600+mi*60+ss) <= w && substr($9,1,1)=="5" && index($7, "/geohot")>0) c++
     } END {print c+0, n+0, first"-"last}'
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
J=$(PGOPTIONS="-c statement_timeout=20s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM articles a WHERE a.processing_state='new' AND a.timeline_at < '2026-10-01+08'" 2>/dev/null | tail -1 | tr -dc '0-9')
T=$(PGOPTIONS="-c statement_timeout=20s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM publications p JOIN articles a ON a.id=p.article_id LEFT JOIN translations tr ON tr.article_id=p.article_id AND tr.lang='zh' WHERE p.selected AND p.visibility='public' AND p.body_mode='full' AND coalesce(a.language,'')<>'zh' AND p.timeline_at < '2026-10-01+08' AND (tr.article_id IS NULL OR (tr.origin<>'source' AND (tr.revision<a.revision OR NOT tr.complete)))" 2>/dev/null | tail -1 | tr -dc '0-9')
[ -n "$J" ] || J=-1
[ -n "$T" ] || T=-1
# 第三个条件：一到九月还有**没扫完的切片**时，"判完了"不等于"回填完了"。
# 17:29 现读 archive_ingest：Jan–Sep 还有 128 片 pending/running（十月那 119 片不算——当月门本来每轮都走）。
# 不算这一项的话，判定腿只要追上进口就会误报"排空"，窗口在半成品上收工。
S=$(PGOPTIONS="-c statement_timeout=20s" psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM archive_ingest WHERE month < '2026-10' AND status <> 'done'" 2>/dev/null | tail -1 | tr -dc '0-9')
[ -n "$S" ] || S=-1
if [ "$J" -le -1 ] || [ "$T" -le -1 ] || [ "$S" -le -1 ]; then LEFT=-1; else LEFT=$(( J + T + S )); fi
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
# 低内存要连续两次才算：一次抽样就撤窗，等于把窗口交给最抖的那一格读数。
PREV=$(cat /run/geohot-r114-lowmem 2>/dev/null || echo 0)
STREAK=$(next_streak "$PREV" "${AVAIL:-0}" "$GEOHOT_FLOOR_AVAIL_MB")
mkdir -p /run 2>/dev/null && printf '%s' "$STREAK" > /run/geohot-r114-lowmem 2>/dev/null
# 停摆检测：判定腿的存量不降 = 判定腿没在干活（门被板凳、worker 卡住、队列被钉住）。
# 静默等到死期限是最贵的一种失败：这几天什么都不产出，还占着实时。连续 6 轮（3 小时）不降就恢复实时。
# **只按判定腿($J)记，不按合计**——翻译量会随判定推进合理地上涨（新入选的要翻），拿合计判会把"正在干活"误读成停摆。
# 状态一行两列：上次判定存量 与 上次计数（只存存量就会把存量当计数，见 next_stall 的注释）。
STATE=$(cat /run/geohot-r114-left 2>/dev/null || echo '')
PREVJ=$(printf '%s' "$STATE" | cut -d' ' -f1)
PREVSTALL=$(printf '%s' "$STATE" | cut -d' ' -f2)
PREVBLIND=$(printf '%s' "$STATE" | cut -d' ' -f3)
STALL=$(next_stall "$PREVJ" "$PREVSTALL" "$J")
E5_WINDOW_SEC=${R114_E5_WINDOW_SEC:-700}
NOWE=$(date +%s)
TODAY0=$(date -d "today 00:00:00" +%s 2>/dev/null || echo 0)
E5RAO=$(e5_count "${R114_NGX:-/var/log/nginx/access.log}" "${R114_E5_TAIL:-20000}" "$E5_WINDOW_SEC" "$(date +%d/%b/%Y)" "$TODAY0" "$NOWE")
E5=$(printf '%s' "$E5RAO" | cut -d' ' -f1)
E5N=$(printf '%s' "$E5RAO" | cut -d' ' -f2)
E5SPAN=$(printf '%s' "$E5RAO" | cut -d' ' -f3)
case "$E5" in ''|*[!0-9]*) E5=-1 ;; esac
# 开窗时刻：拿关阀旗标的 mtime（跨午夜也读得到，且不依赖本轮会话活着）。读不到就传 0，那条上限规则自己不参与。
OPENED=$(date -r /etc/geohot/r114-stop.done +%s 2>/dev/null || echo 0)
# 看不见 = 存量或读者面读数任一坏掉；连续 GEOHOT_BLIND_STREAK 轮就恢复实时（瞎着的哨兵没资格替站长按着进口）。
BLIND=$(next_blind "$PREVBLIND" "$LEFT" "$E5")
mkdir -p /run 2>/dev/null && printf '%s %s %s' "$J" "$STALL" "$BLIND" > /run/geohot-r114-left 2>/dev/null
E5FORJUDGE="$E5"; [ "$E5" -lt 0 ] && E5FORJUDGE=0
ACT=$(decide "$LEFT" "${AVAIL:-0}" "$E5FORJUDGE" "$NOWE" "${DEADLINE_EPOCH:-0}" "$STREAK" "$STALL" "$BLIND" "$OPENED")
echo "$(date -Is) watch 待判=$J 待翻=$T 未扫片=$S 合计=$LEFT avail=${AVAIL:-?}MB lowmem_streak=$STREAK stall_streak=$STALL blind=$BLIND err5xx=${E5}/${E5_WINDOW_SEC}s(样本${E5N:-?}行 ${E5SPAN:-无}) 已开$(( OPENED>0 ? (NOWE-OPENED)/60 : 0 ))min -> $ACT"
case "$ACT" in
  RESTORE*)
    R114_FORCE=1 bash "$BIN/r114-restore-realtime.sh"; rc=$?
    echo "$(date -Is) watch-restore rc=$rc ($ACT)"
    systemctl disable --now geohot-r114-drain-watch.timer 2>/dev/null
    systemctl disable --now geohot-r114-stop.timer geohot-r114-restore.timer 2>/dev/null
    echo "$(date -Is) watch-done 哨兵与两枚窗口定时器已拆"
    # 排空或过了最迟期限：连"每晚 21:00 再关一次阀"也一起停——没活可干就别再占实时。
    # 其余原因（5xx／低内存／停摆／看不见／单窗上限）不动它，明晚照开。
    case "$ACT" in
      *drained*|*deadline*)
        systemctl disable --now geohot-r114-longwindow-start.timer 2>/dev/null
        echo "$(date -Is) watch-nightly-off 依据 $ACT 收工，今晚起不再自动开窗（要再开得手工 --arm-nightly）；归档周期交回日常节律"
        ;;
      *)
        # 还在夜窗政策里：恢复的是"白天"，而 114 那半 reverter 会把归档定时器一起点起来——
        # 17:30 那一轮跑了 28 分钟没完，正好和读者/爬虫撞在一起，所以白天要把它按住。
        systemctl stop geohot-archive.timer 2>/dev/null
        echo "$(date -Is) watch-archive-daypause 白天按住归档周期（active=$(systemctl is-active geohot-archive.timer 2>&1)），今晚 21:00 由 --start 再放行"
        ;;
    esac
    ;;
esac
WATCH
}

unit_svc() { printf '[Unit]\nDescription=%s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nEnvironment=R114_DEADLINE_EPOCH=%s\nEnvironment=R114_FLOOR_AVAIL_MB=%s\nEnvironment=R114_BUDGET_ERR5XX=%s\nEnvironment=R114_LOWMEM_STREAK=%s\nEnvironment=R114_STALL_STREAK=%s\nEnvironment=R114_BLIND_STREAK=%s\nEnvironment=R114_E5_WINDOW_SEC=%s\nExecStart=/bin/bash %s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"; }
unit_tm() { printf '[Unit]\nDescription=%s\n\n[Timer]\nOnCalendar=%s\nRandomizedDelaySec=30\nPersistent=false\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n' "$2" "$3" "$1"; }

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
    local got; got=$(decide "$3" "$4" "$5" "$6" "$7" "${8:-1}" "${9:-0}" "${10:-0}" "${11:-0}")
    case "$got" in
      "$2"*) echo "  OK   $1 → $got" ;;
      *) echo "  WRONG $1：期望 $2 得到 $got"; exit 1 ;;
    esac; }
  chk "排空（0 条）"            RESTORE 0    300 0 1000 2000 1
  chk "未排空且健康"            HOLD   1200  300 0 1000 2000 1
  chk "读者面出 5xx"            RESTORE 1200 300 3 1000 2000 1
  chk "低内存第一次（不算）"    HOLD   1200  40 0 1000 2000 1
  chk "低内存第三次（要撤）"    RESTORE 1200 40 0 1000 2000 3
  chk "到最迟期限"              RESTORE 1200 300 0 2500 2000 1
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
  # 停摆：静默等到死期限是最贵的失败，所以"存量不降"要能自己撤窗；但第一轮不记账、降了就归零。
  [ "$(next_stall '' 0 14692)" = 0 ] && [ "$(next_stall 14692 0 14692)" = 1 ] && [ "$(next_stall 14692 4 14692)" = 5 ] \
    && [ "$(next_stall 14692 3 14690)" = 0 ] \
    && echo "  OK   next_stall：首轮 0、持平 +1、4→5、有降归零" || { echo "  WRONG 停摆计数器不对"; exit 1; }
  # 相邻数证明它有电：读不到存量时必须**不记账**，否则一次 psql 抖动就把窗口撤了。
  [ "$(next_stall 14692 5 '')" = 5 ] && echo "  OK   存量读不到时计数保持不动（不 +1 也不归零，绝不撤窗）" \
    || { echo "  WRONG 坏读数会推进停摆计数"; exit 1; }
  chk "停摆 17 轮（还没到阈值）" HOLD    1200 300 0 1000 2000 1 17
  chk "停摆 18 轮 → 撤窗"        RESTORE 1200 300 0 1000 2000 1 18
  # 单窗上限（9.5 小时）：天亮前必须让回实时，且不依赖"另一半定时器有没有跑成"。now=100000，期限给到无穷远以免抢先。
  chk "开窗 8 小时（未到上限）"    HOLD    1200 300 0 100000 99999999999 1 0 0 71200
  chk "开窗 9.6 小时 → 撤窗"      RESTORE 1200 300 0 100000 99999999999 1 0 0 65440
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
  DPF=$(date +%d/%b/%Y); T0F=1000000000; NOWF=$(( T0F + 17*3600 + 34*60 + 30 ))
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
  # 与旧写法做**差分**：同一组输入必须给出不同答案，否则这条修复根本没落地。
  legacy_decide() { local left="${1:-0}"; if [ "$left" -le -1 ]; then echo "HOLD|unknown_left"; return; fi; if [ "${3:-0}" -gt 0 ]; then echo "RESTORE|reader_5xx=$3"; return; fi; echo "HOLD|legacy"; }
  [ "$(legacy_decide -1 300 5)" = "HOLD|unknown_left" ] && [ "$(decide -1 300 5 1000 2000 1 0 0)" != "HOLD|unknown_left" ] \
    && echo "  OK   差分对照：旧判据在这组输入下说 HOLD（正是要修的），新判据说 $(decide -1 300 5 1000 2000 1 0 0)" \
    || { echo "  WRONG 新旧判据没测出差别 —— 要么顺序没真改，要么夹具在骗人"; exit 1; }
  if ( chk "故意给错的期望" HOLD -1 300 5 1000 2000 1 0 0 ) 2>/dev/null; then
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
  unit_svc geohot-r114-drain-watch "d" 1700000000 60 0 3 6 4 2400 "$BIN/x.sh" > "$T/watch.service"
  grep -q 'Environment=R114_DEADLINE_EPOCH=' "$T/watch.service" && echo "  OK   期限与两个阈值经 Environment= 传进单元（不写死在脚本里）" || { echo "  WRONG 单元没带阈值"; exit 1; }
  grep -q 'Environment=R114_BLIND_STREAK=4' "$T/watch.service" && grep -q 'Environment=R114_E5_WINDOW_SEC=2400' "$T/watch.service" \
    && echo "  OK   看不见阈值与 5xx 窗口也走 Environment=（改这两个不用重编脚本）" || { echo "  WRONG 单元没带 blind/5xx 窗口"; exit 1; }
  echo "  INFO 本次阈值：内存地板 ${FLOOR} MB（连击 ${STREAK_N} 次）∶ 5xx 预算 ${BUDGET} 条（最近 ${E5WIN} s 锚时刻）∶ 停摆 ${STALL_N} 轮（=3 小时存量不降就撤窗）∶ 看不见 ${BLIND_N} 轮∶ 期限 epoch $DEADLINE_EPOCH"
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
  unit_tm  geohot-r114-longwindow-start "GEOHOT long-window nightly open" "*-*-* $NIGHT:00:00" > "$SYS/geohot-r114-longwindow-start.timer"
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
*) echo "用法: $0 --selftest|--start|--arm-nightly|--disarm-nightly|--refresh|--once|--restore|--status"; exit 2;;
esac
