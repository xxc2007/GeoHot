#\!/bin/bash
# 读者面 + 公开 API 的逐路由审计（**要经 deploy/geohot/gated-probe.sh 跑**，它负责进门前查 load/avail/swap）。
# 为什么单独成文件：这条清单 10-18 夜里第一次真跑，34 条里 31 条 200、3 条 /leaderboard* 是 404；
# 那三条是**设计如此**（排行榜功能已下架，路由表还在但页面回 404），写死成期望值，别再把它当缺陷报。
# 节奏：串行、每条之间 3 秒、每条之前查 load1<2.0 / avail>=80MB / swap<=800MB，越线就 ABORT（审计自己让路，不算失败）。
# 用法：gated-probe.sh deploy/geohot/audit-routes.sh --out /d/tmp/audit.out

set -uo pipefail
BASE=http://127.0.0.1/geohot
HOSTH='Host: xxc2007.me'
PASS=0; FAIL=0; SLOW=0
FAILED=""

before() {
  L=$(cut -d' ' -f1 /proc/loadavg); A=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  S=$(free -m | awk '/[Ss]wap/{print $3; exit}')
  if ! awk -v l="$L" 'BEGIN{exit !(l < 2.0)}' || [ "$A" -lt 80 ] || [ "${S:-0}" -gt 800 ]; then
    echo "ABORT load1=$L avail=${A}MB swap=${S}MB —— 审计自己让路，剩下的路由没测（不是失败）"
    echo "AUDIT_ABORTED PASS=$PASS FAIL=$FAIL SLOW=$SLOW"
    exit 4
  fi
}

chk() { # chk <path> <期望码，逗号分隔>
  local p="$1" want="$2" code t
  before
  read -r code t < <(curl -s -o /dev/null -m 25 -w '%{http_code} %{time_total}' -H "$HOSTH" "$BASE$p" 2>/dev/null)
  local ok=0 w
  IFS=','; for w in $want; do [ "$code" = "$w" ] && ok=1; done; unset IFS
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED="$FAILED\n  $p → $code（期望 $want）"; fi
  awk -v t="$t" 'BEGIN{exit !(t > 2.0)}' && { SLOW=$((SLOW+1)); printf '  SLOW %-46s %s %ss\n' "$p" "$code" "$t"; }
  sleep 3
}

echo "=== 读者面 + 公开 API 审计（串行、每条之间 3 秒、每条之前查 load/avail）==="
date -Is
for spec in \
  "/|200" \
  "/all|200" \
  "/all?category=regional|200" \
  "/hot|200" \
  "/daily|200" \
  "/daily/archive|200" \
  "/daily/2026-10-18|200" \
  "/weekly|200" \
  "/monthly|200" \
  "/topics|200" \
  "/topics/landforms|200" \
  "/topics/volcanoes|200" \
  "/items/a9jbis94r6jsd639cjbg2ohpw|200" \
  "/items/a9jbis94r6jsd639cjbg2ohpw/original|200,302" \
  "/story/10b360db-d9e5-4e0d-9b74-55ace986b203|200" \
  "/about|200" \
  "/terms|200" \
  "/privacy|200" \
  "/changelog|200" \
  "/feedback|200" \
  "/more|200" \
  "/starred|200" \
  "/agent|200" \
  "/leaderboard|404" \
  "/leaderboard/rules|404" \
  "/leaderboard/sources|404" \
  "/robots.txt|200" \
  "/api/site/reports/daily?limit=2|200" \
  "/api/site/reports/weekly?limit=2|200" \
  "/api/site/stats|200" \
  "/admin|302,401" \
  "/admin/login|200" \
  "/admin/content|302,401" \
  "/this-route-does-not-exist|404" ; do
  chk "${spec%|*}" "${spec##*|}"
done

echo
echo "=== 结果 ==="
printf '  PASS=%s FAIL=%s SLOW(>2s)=%s\n' "$PASS" "$FAIL" "$SLOW"
[ -n "$FAILED" ] && printf "$FAILED\n"
cut -d' ' -f1-3 /proc/loadavg | sed 's/^/  load=/'
free -m | awk '/[Ss]wap/{print "  swap 已用="$3}'; awk '/MemAvailable/{print "  avail_MB="int($2/1024)}' /proc/meminfo
echo AUDIT_DONE
