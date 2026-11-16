#!/bin/bash
# 从模型池里摘掉 magpie 已经不认的成员。
#
# 为什么要有它：模型池是手写在 .env 里的一串别名，而 magpie 那一侧的账号会掉线、
# 模型会下架。2026-11-16 实测：池子里躺着 11 个别名（79 个成员位）打过去就是 404，
# 一小时 60 次失败里有一半是它们——每一次都要先撞一次 404 才轮到下一个模型。
#
# 判据来自探针实测（tooling/model-pool-dead.txt），不是拿 /v1/models 对表：
# magpie 能接受别名与裸 id，对表会造出假死。
#
# 用法：prune-model-pool.sh [dead 文件] [env 文件]
#   dead 文件默认 tooling/model-pool-dead.txt（脚本同目录里的 model-pool-dead.txt）
#   env 文件默认 /opt/geohot/app/.env；执行器上是 /opt/geohot-exec/.env
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dead_file="${1:-$here/model-pool-dead.txt}"
env_file="${2:-/opt/geohot/app/.env}"

[ -f "$dead_file" ] || { echo "找不到失效清单 $dead_file" >&2; exit 1; }
[ -f "$env_file" ] || { echo "找不到 env $env_file" >&2; exit 1; }

mapfile -t dead < <(grep -v '^#' "$dead_file" | grep -v '^[[:space:]]*$' | tr -d '\r')
[ "${#dead[@]}" -gt 0 ] || { echo "失效清单是空的，什么都不做"; exit 0; }

stamp="$(date +%Y%m%d%H%M%S)"
cp -p "$env_file" "$env_file.bak-pool-$stamp"

removed=0
while IFS= read -r line; do
  case "$line" in
    ''|'#'*) printf '%s\n' "$line"; continue ;;
  esac
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    *_MODEL|*_MODELS) ;;
    *) printf '%s\n' "$line"; continue ;;
  esac
  kept=""
  IFS=',' read -r -a members <<<"$value"
  for m in "${members[@]}"; do
    skip=0
    for d in "${dead[@]}"; do
      [ "$m" = "$d" ] && skip=1 && break
    done
    if [ "$skip" = 1 ]; then removed=$((removed + 1)); continue; fi
    kept="${kept:+$kept,}$m"
  done
  if [ -z "$kept" ]; then
    printf '%s\n' "$line"
  else
    printf '%s=%s\n' "$key" "$kept"
  fi
done < "$env_file.bak-pool-$stamp" > "$env_file"

echo "摘掉 $removed 个成员位，备份 $env_file.bak-pool-$stamp"
grep -cE '^[A-Z0-9_]*MODELS?=' "$env_file" | sed 's/^/池子行数: /'
