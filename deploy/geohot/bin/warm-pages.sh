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
# 2026-11-15：读者面最贵的是首页与「全部」两屏（时间线 + 收录池要现算）。后台流水线一开，
# 冷请求 2.5–5 秒；nginx 缓存 60 秒一过期，每一分钟就有一个真读者替全站付这笔钱。
# 于是把这两屏单独交给一个 60 秒的高频预热带（geohot-warm-hot.timer），其余四屏仍走 2 分钟。
# 路径可用 GEOHOT_WARM_PATHS 覆盖（空格分隔），方便临时只热某一屏。
if [ -n "${GEOHOT_WARM_PATHS:-}" ]; then
  read -r -a PATHS <<<"${GEOHOT_WARM_PATHS}"
else
  PATHS=(
    "/geohot/"
    "/geohot/all?tab=all"
    "/geohot/hot"
    "/geohot/daily"
    "/geohot/topics"
  )
fi

warm() {
  local path="$1"
  curl -k -sS -o /dev/null -m 25 \
    --resolve "${HOST}:443:127.0.0.1" \
    -H "accept: text/html" \
    -H "user-agent: geohot-warm/1" \
    -w "%{http_code} %{time_total} %{header_json}" \
    "https://${HOST}${path}" 2>/dev/null | head -c 400
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
