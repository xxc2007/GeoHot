#!/usr/bin/env bash
# 读者面的缓存预热。
#
# 2026-11-14 现场：主库只有一块 ~250 IOPS 的盘，后台流水线一开，`/geohot/` 的冷请求就要
# 3.5–15 秒（时间线那一屏要现算），而 nginx 缓存每 60 秒过期一次 —— 于是每一分钟都有一个
# 真实读者替全站付这份钱。
#
# 这里做的就是把「付钱的人」换成定时器：每 20 秒按读者会走的 URL（同一个 scheme + Host）
# 请求一遍源站，nginx 命中即刷新；等真读者进来时，`proxy_cache` 里永远是热的。
# 请求走 127.0.0.1，不走公网，也不消耗 Cloudflare 的额度。
set -u

HOST="xxc2007.me"
# 预热打的是哪个 scheme，决定它热的是哪把缓存键：public-cache-location.conf:3 的
# proxy_cache_key 是 `report-workflow-v1:$scheme$host$request_uri`。docs/known-issues.md:30 记着
# 「Cloudflare 回源是明文 80（CF↔源站是 http）」；如果线上仍是这样，而这里一直用 https 预热，
# 那热的是 https 那把键，真实读者经 CF 读的是 http 那把 —— 预热等于白做（这也解释了为什么中文屏
# 常常只是 STALE 而不是 HIT）。所以把 scheme 做成旋钮，并在改动前先按下面这段核实：
#   curl -sI -H 'Host: xxc2007.me' http://127.0.0.1/geohot/   | grep -i x-geohot-public-cache
#   curl -skI -H 'Host: xxc2007.me' https://127.0.0.1/geohot/ | grep -i x-geohot-public-cache
# 两边的 Age/状态不同就说明两把键是分开的；确认 CF 走 80 之后在 unit 里写 GEOHOT_WARM_SCHEME=http。
# 反过来，如果 80 上只回 301 到 https，那说明 80 不是 CF 的回源口（也就没走 80 的缓存），
# 这时 curl 拿不到 x-geohot-public-cache、日志里会出现 code=301 —— 别把它当成预热失败去调阈值。
SCHEME="${GEOHOT_WARM_SCHEME:-https}"
# 2026-11-15：读者面最贵的是首页与「全部」两屏（时间线 + 收录池要现算）。后台流水线一开，
# 冷请求 2.5–5 秒；nginx 缓存 60 秒一过期，每一分钟就有一个真读者替全站付这笔钱。
# 于是把这两屏单独交给一个 60 秒的高频预热带（geohot-warm-hot.timer），其余四屏仍走 2 分钟。
# 路径可用 GEOHOT_WARM_PATHS 覆盖（空格分隔），方便临时只热某一屏。
if [ -n "${GEOHOT_WARM_PATHS:-}" ]; then
  read -r -a PATHS <<<"${GEOHOT_WARM_PATHS}"
else
  PATHS=("/geohot/")
  # 2026-11-27：/en 此前既不在缓存路由表里、也不在任何预热带里，每一屏都是源站冷渲染，且失败时没有
  # proxy_cache_use_stale 兜底（中文屏同刻靠 STALE 200 顶着）。缓存路由已经补上（public-cache.conf），
  # 但预热**要等 scheme 核实过才加**：scheme 没核实之前，这条新路径写进的是没人读的那把键，
  # 等于每 2 分钟在 2 vCPU 的机器上白买一次冷渲染。所以只有 GEOHOT_WARM_SCHEME 被显式设置
  # （= 有人按上面的两条 curl 确认过）才把它排进来。排在第二位是给 TimeoutStartSec=180 留余量
  # （每条最多 -m 25 秒，六条正好 150 秒，库慢时被截断的是队尾）。
  if [ -n "${GEOHOT_WARM_SCHEME:-}" ]; then
    PATHS+=("/geohot/en")
  fi
  PATHS+=(
    "/geohot/all?tab=all"
    "/geohot/hot"
    "/geohot/daily"
    "/geohot/topics"
  )
fi

# 2026-11-16：机器自己已经忙不过来的时候，预热必须让路。
# 现场：内存被换出（`memory full avg10=96`、swap 用掉 830 MB）时 `io some avg10` 也是 99，
# 而预热的每一屏都是一次冷渲染 —— 它在最贵的时候加最贵的活。读者面有 `proxy_cache_use_stale`
# 兜着，宁可用旧页，也不要在这时候再点一次火。
IO_FILE="${GEOHOT_WARM_IO_FILE:-/proc/pressure/io}"
MEM_FILE="${GEOHOT_WARM_MEM_FILE:-/proc/pressure/memory}"
IO_LIMIT="${GEOHOT_WARM_MAX_IO:-60}"
MEM_LIMIT="${GEOHOT_WARM_MAX_MEM:-40}"

pressure_avg10() { # $1=some/full $2=文件
  awk -F'avg10=' -v section="$1" '$0 ~ "^" section {split($2, a, " "); print a[1]; found=1} END {if (!found) print 0}' "$2"
}

io_now="$(pressure_avg10 some "$IO_FILE")"
io_iv="${io_now%%.*}"; case "$io_iv" in ''|*[!0-9]*) io_iv=0 ;; esac
mem_now="$(pressure_avg10 full "$MEM_FILE")"
mem_iv="${mem_now%%.*}"; case "$mem_iv" in ''|*[!0-9]*) mem_iv=0 ;; esac
if [ "$io_iv" -ge "$IO_LIMIT" ] || [ "$mem_iv" -ge "$MEM_LIMIT" ]; then
  echo "-- skip: io some avg10=$io_now memory full avg10=$mem_now（线 ${IO_LIMIT}/${MEM_LIMIT}）让读者面自己缓"
  exit 0
fi

warm() {
  local path="$1"
  # scheme 与端口必须和「真实读者到达源站时用的那把缓存键」一致，见文件头部的说明。
  if [ "$SCHEME" = "http" ]; then
    curl -sS -o /dev/null -m 25 \
      --resolve "${HOST}:80:127.0.0.1" \
      -H "accept: text/html" \
      -H "user-agent: geohot-warm/1" \
      -w "%{http_code} %{time_total} %{header_json}" \
      "http://${HOST}${path}" 2>/dev/null | head -c 400
  else
    curl -k -sS -o /dev/null -m 25 \
      --resolve "${HOST}:443:127.0.0.1" \
      -H "accept: text/html" \
      -H "user-agent: geohot-warm/1" \
      -w "%{http_code} %{time_total} %{header_json}" \
      "https://${HOST}${path}" 2>/dev/null | head -c 400
  fi
}

for path in "${PATHS[@]}"; do
  out="$(warm "$path")"
  code="${out%% *}"
  # 3xx/5xx 不是这台机器该修的事：预热带 `-k`，只看有没有把页面算出来。
  if [ "$code" != "200" ]; then
    logger -t geohot-warm "warm failed path=${path} code=${code}"
  fi
done

exit 0
