#!/usr/bin/env bash
# 读者面探针（国内节点 8.148.65.89）：每 5 分钟打一遍公开出口，慢或失败都写进 journal。
# 用 curl 而不是无头浏览器：Cloudflare 的机器人评分会把无头 Chromium 拦成挑战页（实测 /topics 45 秒超时），
# 而 curl 拿到的是读者真正拿到的 HTML —— 检查的是「站能不能开、有多快」，不是「JS 跑得对不对」。
set -uo pipefail
BASE=${BASE:-https://xxc2007.me/geohot}
SLOW_MS=${SLOW_MS:-5000}
fail=0

probe() {
  local path="$1" want="$2" out code ms
  out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "$BASE$path" || echo "000 0")
  code=${out% *}; ms=${out#* }
  if [ "$code" != "$want" ]; then
    out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "$BASE$path" || echo "000 0")
    code=${out% *}; ms=${out#* }
  fi
  local ms_int=${ms%.*}; ms_int=${ms_int:-0}
  if [ "$code" != "$want" ]; then
    fail=1; echo "FAIL $path -> $code after ${ms}s"
  elif [ "$ms_int" -ge "$SLOW_MS" ]; then
    echo "SLOW $path $code ${ms}s"
  else
    echo "ok $path $code ${ms}s"
  fi
}

probe / 200
probe /all 200
probe /topics 200
probe /changelog 200
probe /feed.xml 200
probe /api/health 200
exit $fail
