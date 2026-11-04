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
  # **重启宽限**（2026-11-04）：单元重启的那一两分钟里 nginx 对正在换血的 upstream 回 502/503，
  # 2026-11-04 09:23 的一次部署就攒出 12 条 5xx，把 worker 停了 30 分钟——那不是读者受害，是我们
  # 自己在重启。调用方可用 R114_E5_EXCLUDE_FROM/TO（epoch 区间）把这段排除；不传就是原行为。
  local exf="${R114_E5_EXCLUDE_FROM:-0}" ext="${R114_E5_EXCLUDE_TO:-0}"
  case "$exf" in ''|*[!0-9]*) exf=0 ;; esac
  case "$ext" in ''|*[!0-9]*) ext=0 ;; esac
  tail -n "$2" "$1" 2>/dev/null | awk -v d="$4" -v t0="$5" -v d2="${7:-}" -v t02="${8:-0}" -v now="$6" -v w="$3" -v exf="$exf" -v ext="$ext" '
    { base=0
      if (d2 != "" && index($4, "[" d2 ":")==1) base=t02
      else if (index($4, "[" d ":")==1) base=t0
      else next
      n++; if (first=="") first=substr($4,14,5); last=substr($4,14,5)
      hh=substr($4,14,2)+0; mi=substr($4,17,2)+0; ss=substr($4,20,2)+0
      if (base>0 && substr($9,1,1)=="5" && index($7, "/geohot")>0) {
        age=now-(base+hh*3600+mi*60+ss)
        abs=base+hh*3600+mi*60+ss
        skip=(ext>exf && abs>=exf && abs<=ext)
        if (age >= -5 && age <= w) { if (skip) x++; else c++ }
      }
    } END { if (n+0 == 0) print "-1 0 无当日样本"; else print c+0, n+0, first"-"last, x+0 }'
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
    # 但"探针答不出来"不等于"操作者停的"：`systemctl is-active` 超时/被拒时输出是 unknown/空，
    # 以前一律按操作者停机跳过 —— 于是 5xx 早已超预算，闸门却一直 SLIP，读者在挨打而没人动手。
    # 只有明确读到 inactive/failed 才认"别人停的"，读不准就按 TRIP 处理（日志里 worker=unknown 可见）。
    if [ "$we_stopped" = 1 ]; then echo TRIP
    elif [ "$active" = active ]; then echo TRIP
    elif [ "$active" = inactive ] || [ "$active" = failed ]; then echo SKIP_OPERATOR_STOPPED
    else echo TRIP; fi
    return
  fi
  # 只有已记录停止意图、由本闸门承担恢复责任的才可自动恢复；operator 自己停的 worker 不碰。
  if [ "$we_stopped" = 1 ]; then
    if [ "$active" = active ]; then echo CONFIRM_RELEASE; else echo RELEASE; fi
    return
  fi
  echo IDLE
}
