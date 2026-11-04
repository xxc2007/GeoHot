#!/bin/bash
# No paid calls or DB scans. Require two consecutive healthy minute samples.
#
# 2026-11-04 起这套阈值与 background intake 用的是同一组旋钮（`GEOHOT_RECOVER_*`），
# 原因：原来写死 MemAvailable>=98304kB / memory.full<10 / io.full<30，
# 而 891MB 的机器上 memory.full 长期在 20–25（swap 用掉 700MB+），
# 于是闸门永远凑不齐两次健康样本 —— 19:46 现场首页已经 0.6–1.1s 还在 RECOVERY-WAIT，
# 一停十几分钟、积压不动。读者真正的失败信号是 5xx，闸门自己就在数那一条。
set -euo pipefail
state=${R115_READY_STATE:-/run/geohot-r115-ready}
available_kb=$(( ${GEOHOT_RECOVER_AVAILABLE_MIB:-64} * 1024 ))
memory_full=${GEOHOT_RECOVER_MEMORY_FULL:-25}
io_full=${GEOHOT_RECOVER_IO_FULL:-50}
healthy=1
awk -v want="$available_kb" '/^MemAvailable:/ {ok=($2>=want)} END {exit !ok}' /proc/meminfo || healthy=0
awk -v want="$memory_full" '/^full / {split($2,a,"=");ok=(a[2]<want)} END {exit !ok}' /proc/pressure/memory || healthy=0
awk -v want="$io_full" '/^full / {split($2,a,"=");ok=(a[2]<want)} END {exit !ok}' /proc/pressure/io || healthy=0
# Reader request stays local and never traverses model routes.
# 2026-11-04 起这条 HTTP 探针默认只是"参考信号"，不是否决票：
#   - 闸门 TRIP 的判据是 nginx 的 5xx（读 700 秒窗口），恢复时再看一次 5xx；
#   - 这台 891MB 的机器换页一抖，首页偶尔 8s 才出，但随后又是 0.3s（19:50 现场连测五次数值
#     0.29–1.36s，同一条探针却 8s 超时）。拿一条容易抖的延迟信号去否决恢复，
#     结果就是"读者明明正常，积压却停十几分钟"。
# 需要严格把关时设 GEOHOT_RECOVERY_REQUIRE_HTTP=1，超时即判不健康。
if ! curl -fsS -o /dev/null --max-time 8 http://127.0.0.1:3000/geohot/; then
  if [[ "${GEOHOT_RECOVERY_REQUIRE_HTTP:-0}" == "1" ]]; then healthy=0; fi
  echo "reader probe slow or failed (advisory): $(date -Is)" >&2
fi
now=$(date +%s)
prior=0
[[ ! -r "$state" ]] || read -r prior < "$state"
[[ "$prior" =~ ^[0-9]+$ ]] || prior=0
if [[ "$healthy" != 1 ]]; then rm -f -- "$state"; exit 1; fi
printf '%s\n' "$now" > "$state"
(( prior > 0 && now-prior >= 40 && now-prior <= 150 ))