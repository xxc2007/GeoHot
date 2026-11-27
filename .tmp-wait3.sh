#!/bin/bash
# 等那次远程部署收尾（日志出现 RESULT / FAIL / 或脚本进程消失），每 40 秒看一次，最多 30 分钟。
set -uo pipefail
K="ibk_rk5gh4tvhm4zzxslccyssppxlxmcs5vuctbeljrf4b3jxmnncpoq"
M="m_agq566xboeglgwufg5qvn7qxle"
for i in $(seq 1 45); do
  out=$(curl -s --max-time 40 -X POST "https://api.instabox.sh/v1/machines/$M/exec" -H "X-API-Key: $K" -H 'content-type: application/json' \
    -d '{"cmd":"if grep -qE \"^RESULT\" /tmp/deploy-395.log 2>/dev/null; then echo DONE; tail -8 /tmp/deploy-395.log; else echo WAIT $(tail -1 /tmp/deploy-395.log); fi"}')
  case "$out" in
    *DONE*) echo "$out"; exit 0 ;;
  esac
  sleep 40
done
echo TIMEOUT