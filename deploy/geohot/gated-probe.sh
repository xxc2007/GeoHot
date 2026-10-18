#!/bin/bash
# 给"只读探针"加一道机器自己的闸门。为什么要有这个文件（2026-10-18 20:5x，我自己造的事故）：
# 连续窗口开着的时候，我为了算一条账在机器上跑了两把没限流的读数（其中一把要按 timeline 过滤 1.6 万条 new 行），
# load1 从 2 出头冲到 16.4，读者面在同一时刻被数出 12 条 5xx —— 哨兵那条"读者的路一红就恢复实时"当场开火，
# 窗口白丢一小时。**判据没错，是我这个旁观者在打错的靶子上加压。**
#
# 所以规矩不能只写在我的注释里，要写成脚本会自己拒绝：
#   · 闸门与载荷跑在**同一个 ssh 会话的同一个 bash 进程**里——分两次连就有时差，load 在这段时间里会变。
#   · 越线就 exit 3，载荷一行都不执行；拒绝时把当时的 load／内存／swap 打出来，让"为什么没跑"也可审计。
#   · 没有 --force：真要绕过这道闸就得自己手写那条 ssh——让绕路比用脚本更麻烦，才是设计。
#
# 默认值怎么定下来的（2026-10-18 21:09 现场校准，第一版写 120 结果把自家诊断挡在门外）：
#   这台 891 MB 的机器夜里 MemAvailable 的**正常区间就是 100—250 MB**（当晚实测 105/106/111/123/128/132/135/157/182/191/198/255），
#   而读者面守护的地坪是 40 MB、事故那一拍读到的是 74 MB。所以地板取 **80 MB**：低于常态、高于"已经在痛"的那一档。
#   教训一条：**闸门的地坪要拿常态分布定，不是拿我希望的数值定**——定高了，工具会在最需要它的时候被绕过。
# 22:1x 对抗代理打中两处，都改的是"闸门自己会不会瞎"：
#   · swap 那格原来匹配 `free -m` 的小写 `/swap/`，表头是 `Swap:` ⇒ 永不命中 ⇒ 顶 1400 MB 这条腿**一直是装饰**，
#     而我据此连报三拍 `swap=0MB`（真值 868 MB）。**量具瞎了会给"看着干净"的数，比不量更坏。**
#   · 任何一格读不到数字（nproc/load1/avail/swap）现在都 `exit 3` 拒绝——**闸门在瞎的时候必须失败朝向拒绝**，
#     原来 SW 空会归 0、BAD 算成 0，等于"读不到就放行"。
#
# 用法（凭据与主机一律从环境取，仓库里不写源站地址与用户名）：
#   export GATE_SSH_TARGET='<ssh-user>@<host>'
#   export GATE_SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=25 -o UserKnownHostsFile=... -i ..."
#   deploy/geohot/gated-probe.sh /d/tmp/探针.lf [--out /d/tmp/结果.out] [--max-per-cpu 1.5] [--min-avail-mb 80] [--max-swap-mb 1400]
#
# 默认值怎么定下来的（2026-10-18 21:09 现场校准，第一版写 120 结果把自家诊断挡在门外）：
#   这台 891 MB 的机器夜里 MemAvailable 的**正常区间就是 100—250 MB**（当晚实测 105/106/111/123/128/132/135/157/182/191/198/255），
#   而读者面守护的地坪是 40 MB、事故那一拍读到的是 74 MB。所以地板取 **80 MB**：低于常态、高于"已经在痛"的那一档。
#   教训一条：**闸门的地坪要拿常态分布定，不是拿我希望的数值定**——定高了，工具会在最需要它的时候被绕过。
set -uo pipefail

PAYLOAD=""; OUT=""; MAXPC=1.5; MINAVAIL=80; MAXSWAP=1400
# 每个带值的旗标先数够不够两个参数：`shift 2` 在只剩一个参数时会报"count out of range"并且**不消费任何参数**，
# 于是 `gated-probe.sh p.sh --out`（忘了给值）会在这个 while 里**永久打转**（2026-10-18 对抗代理抓到）。
need2() { [ "$#" -ge 2 ] || { echo "REFUSE $1 后面要跟一个值"; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) need2 "$@"; OUT="$2"; shift 2;;
    --max-per-cpu) need2 "$@"; MAXPC="$2"; shift 2;;
    --min-avail-mb) need2 "$@"; MINAVAIL="$2"; shift 2;;
    --max-swap-mb) need2 "$@"; MAXSWAP="$2"; shift 2;;
    -h|--help) sed -n "1,30p" "$0"; exit 0;;
    *) [ -n "$PAYLOAD" ] || PAYLOAD="$1"; shift;;
  esac
done
[ -n "$PAYLOAD" ] || { echo "REFUSE 要一个本地探针文件：gated-probe.sh <文件> [--out 结果] [--max-per-cpu 1.5] [--min-avail-mb 120]"; exit 2; }
[ -f "$PAYLOAD" ] || { echo "REFUSE 探针文件读不到：$PAYLOAD"; exit 2; }
[ -n "${GATE_SSH_TARGET:-}" ] || { echo "REFUSE 没设 GATE_SSH_TARGET（仓库里故意不写主机与用户名）"; exit 2; }
case "$MAXPC" in ''|*[!0-9.]*) echo "REFUSE --max-per-cpu 要个小数"; exit 2;; esac
case "$MINAVAIL" in ''|*[!0-9]*) echo "REFUSE --min-avail-mb 要个整数"; exit 2;; esac
case "$MAXSWAP" in ''|*[!0-9]*) echo "REFUSE --max-swap-mb 要个整数"; exit 2;; esac

GATE=$(printf '%s\n' \
'set -u' \
'NP=$(nproc); L1=$(cut -d" " -f1 /proc/loadavg)' \
'AV=$(awk "/MemAvailable/{print int(\$2/1024)}" /proc/meminfo)' \
'# swap 那一格以前写 /swap/ 匹配 `free -m` 的表头 ⇒ 永不命中、SW=0 ⇒ 这条腿一直是装饰（2026-10-18 22:1x 对抗代理打中）。' \
'# 当晚真值：Swap 2047 总 / 868 已用，而我连报了三拍 "swap=0MB"——量具瞎了比没量具更坏，因为它会给出"看着干净"的数。' \
'SW=$(free -m | awk "/[Ss]wap/{print \$3; exit}")' \
'BLIND=""' \
'case "$NP" in ''|*[!0-9]*) BLIND="$BLIND nproc";; esac' \
'case "$L1" in ''|*[!0-9.]*) BLIND="$BLIND load1";; esac' \
'case "$AV" in ''|*[!0-9]*) BLIND="$BLIND avail";; esac' \
'case "$SW" in ''|*[!0-9]*) BLIND="$BLIND swap";; esac' \
'if [ -n "$BLIND" ]; then' \
'  printf "GATE_BLIND 读不到%s —— 闸门宁可拒绝也不放载荷过去（load1=[%s] avail=[%s] swap=[%s]）\n" "$BLIND" "$L1" "$AV" "$SW"' \
'  exit 3' \
'fi' \
'CAP=$(awk -v n="$NP" -v m="'"$MAXPC"'" "BEGIN{printf \"%.2f\", n*m}")' \
'printf "GATE load1=%s ∶ 上限=%s（%s 核 × %s）avail=%sMB ∶ 地板=%sMB swap=%sMB ∶ 顶=%sMB\n" "$L1" "$CAP" "$NP" "'"$MAXPC"'" "$AV" "'"$MINAVAIL"'" "$SW" "'"$MAXSWAP"'"' \
'BAD=$(awk -v l="$L1" -v c="$CAP" -v a="$AV" -v f="'"$MINAVAIL"'" -v s="$SW" -v m="'"$MAXSWAP"'" "BEGIN{print (l+0 > c+0 || a+0 < f+0 || s+0 > m+0) ? 1 : 0}")' \
'if [ "$BAD" = 1 ]; then' \
'  echo "LOAD_GATE_REFUSED —— 载荷一行都没跑；这不是坏消息，这就是这道闸该做的事"' \
'  exit 3' \
'fi' \
'echo "GATE_OK 过闸，开始跑载荷"')

SRC=$(tr -d '\r' < "$PAYLOAD")
if [ -n "$OUT" ]; then
  { printf '%s\n' "$GATE"; printf '%s\n' "$SRC"; } | ssh ${GATE_SSH_OPTS:-} "$GATE_SSH_TARGET" 'sudo -n bash -s' > "$OUT" 2>&1
  rc=$?
  echo "gated-probe rc=$rc 输出=$OUT（$(wc -c < "$OUT") 字节）"
  grep -q 'LOAD_GATE_REFUSED' "$OUT" && echo "本次被闸门拒绝（原因见文件里 GATE 那一行现值）"
  exit $rc
fi
{ printf '%s\n' "$GATE"; printf '%s\n' "$SRC"; } | ssh ${GATE_SSH_OPTS:-} "$GATE_SSH_TARGET" 'sudo -n bash -s'
