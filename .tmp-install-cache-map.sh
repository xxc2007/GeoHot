#!/bin/bash
# 把 /en 纳入 nginx 公共缓存路由（按 deploy/geohot/public-cache.conf 头部写明的流程）。
# 备份 → install → nginx -t（不过就还原）→ reload → 用响应头确认不再是 BYPASS。
set -uo pipefail
SRC=/tmp/public-cache.conf.new
[ -f "$SRC" ] || { echo "ABORT: $SRC 不在"; exit 1; }

targets=$(grep -rln 'geohot_cache_route' /etc/nginx 2>/dev/null | head -3)
[ -n "$targets" ] || { echo "ABORT: /etc/nginx 里找不到带 geohot_cache_route 的文件"; exit 1; }
echo "target(s): $targets"

stamp=$(date +%s)
for f in $targets; do
  cp -a "$f" "/root/nginx-cache-route.bak.$stamp"
  echo "backup: /root/nginx-cache-route.bak.$stamp ($f)"
done

for f in $targets; do install -m 644 "$SRC" "$f"; done
if nginx -t 2>/tmp/nginx-t.log; then
  systemctl reload nginx
  echo "reload: ok"
else
  echo "nginx -t 失败，已还原："
  head -5 /tmp/nginx-t.log
  for f in $targets; do install -m 644 "/root/nginx-cache-route.bak.$stamp" "$f"; done
  nginx -t && systemctl reload nginx
  exit 1
fi

sleep 1
echo "--- 验证响应头 ---"
curl -sI -H 'Host: xxc2007.me' http://127.0.0.1/geohot/en | grep -iE '^HTTP|x-geohot-public-cache' | head -3
curl -sI -H 'Host: xxc2007.me' http://127.0.0.1/geohot/en/all | grep -iE '^HTTP|x-geohot-public-cache' | head -3