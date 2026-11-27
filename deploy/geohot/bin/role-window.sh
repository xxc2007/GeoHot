#!/bin/bash
# 执行器的昼夜档：白天只采集，夜里才开分析。
#
# 为什么需要它：2026-11-15 在主库（891 MB / 2 vCPU / 单块 ~250 IOPS 的盘）上实测，
# 只要有任何分析并发，`/proc/pressure/io` 立刻回到 99%，读者面从 6 ms 掉到 5–15 秒，
# 甚至直接 000。采集（sources.fetch）是网络活、几乎不写库，可以白天一直跑；
# 分析（content.analyze）是重写 + 大扫，只能等夜里读者少的时候做。
#
# 用法：role-window.sh day|night [env 文件]
#   day   → WORKER_ROLE=all，分析槽 1（采集与正文提取照跑）
#   night → WORKER_ROLE=all，分析槽 2（四台执行器各 2 槽：夜里 8 个并发）
#
# 槽位可用环境变量调：GEOHOT_ROLE_DAY_SLOTS（默认 1）、GEOHOT_ROLE_NIGHT_SLOTS（默认 2）。
# 英文腿同理：GEOHOT_ROLE_ENGLISH_SLOTS（默认 0）——只有回填节点设 1，且只在夜间档生效，白天一律 0。
# 2026-11-16 起白天从 0 改成 1：当天实测主库 io some avg10 只有 5.9、load 0.9，
# 而积压里躺着 2,163 条 content.analyze；把白天压成 0 是旧的保守值，
# 现在的账是「一台机器一个分析槽，主库压力仍低一个数量级」。
#
# 注意（别删）：systemd 的 `Environment=` **优先于** `EnvironmentFile=`。本脚本写的是 .env，
# 一旦 drop-in 里有同名 ENGLISH_* 覆盖，这里写下去的值会被静默盖掉（脚本会先扫一遍并打 warn）。
#
# 为什么白天也写 WORKER_ROLE=all：`extraction` 在 worker-role.ts 里是
# `role !== coordinator && role !== fetcher && role !== media` —— 写成 fetcher 会把
# 「正文提取」一起关掉。2026-11-15 白天三台云机全切 fetcher，6 小时里堆下 420 条
# `body_status=pending`，读者面因此只剩标题。白天真正要停的只有分析，靠
# `GEOHOT_INTAKE_ANALYSIS_SLOTS=0` 拦（intake 按 analysis 车道单独计数）。
#
# 另一个坑：`ANALYZE_CONCURRENCY=0` 会被 config 当成「不是正整数」回落到 6/4，
# 反而把分析开大。所以这两个键都写 1，用 slots 决定开不开分析。
set -u

mode="${1:-day}"
env_file="${2:-/opt/geohot-exec/.env}"

case "$mode" in
  # 2026-11-16 11:00：白天四台各 1 槽一起开工，主库 `io some avg10` 又回到 99、load 40，
  # 后台登录 504、`/api/health` 要 464 秒——一条慢盘撑不住四个分析器同时写。
  # 白天只留一台（离主库最近的华为云）做分析，其余三台 `GEOHOT_ROLE_DAY_ACTIVE=0`：
  # 它们照样采集、照样提取正文（`sources.fetch`/`content.extract-body` 是网络活），
  # 只是分析槽写 0 —— intake 按 analysis 车道单独计数，这一条不会把整个 worker 关掉。
  day)
    role=all
    if [ "${GEOHOT_ROLE_DAY_ACTIVE:-1}" = "0" ]; then slots=0; else slots="${GEOHOT_ROLE_DAY_SLOTS:-1}"; fi
    ;;
  night) role=all; slots="${GEOHOT_ROLE_NIGHT_SLOTS:-2}" ;;
  *) echo "用法：$0 day|night [env 文件]" >&2; exit 2 ;;
esac

if [ ! -f "$env_file" ]; then
  echo "找不到 $env_file" >&2
  exit 1
fi

# 先备份再改：这几个键曾经被 systemd drop-in 盖掉过，出问题时能一眼对比回来。
cp -p "$env_file" "$env_file.bak-role-$(date +%H%M%S)"

# 约束（别删）：systemd 的 `Environment=` **优先于** `EnvironmentFile=`。本脚本写的是 .env（默认 /opt/geohot-exec/.env），
# 一旦有人给 geohot-exec-worker 加一条 `Environment=ENGLISH_CONCURRENCY=1` 的 drop-in，窗口脚本就再也关不掉它，
# 「早上写回 0」会静默失效——上面那句「这几个键曾经被 systemd drop-in 盖掉过」记的就是同一类旧伤。
# 发现同名覆盖就喊一声（连命中的文件:行一起打出来），让人先看见再决定。
for u in geohot-exec-worker geohot-worker; do
  unit_dir="/etc/systemd/system/${u}.service.d"
  [ -d "$unit_dir" ] || continue
  hits="$(grep -rnsE '^[[:space:]]*Environment=.*ENGLISH_' "$unit_dir" 2>/dev/null)"
  if [ -n "$hits" ]; then
    msg="WARN: ${unit_dir} 里有 Environment= 覆盖 ENGLISH_*；systemd 的 Environment= 优先于 EnvironmentFile=，窗口脚本写 .env 不会生效"
    logger -t geohot-role "$msg"
    echo "$msg" >&2
    printf '%s\n' "$hits" >&2
  fi
done

set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_key WORKER_ROLE "$role"
# 恒定写 1：写 0 会被当成非法值回落到 6/4，反而把分析开大。
set_key ANALYZE_CONCURRENCY "1"
set_key GEOHOT_INTAKE_ANALYSIS_SLOTS "$slots"

# 英文腿：只有被点名的回填节点在夜间开（GEOHOT_ROLE_ENGLISH_SLOTS=1），其余节点与白天一律 0。
#
# 2026-11-27：这两个键此前没有任何执行器侧的窗口脚本会写——worker-window.sh（:53/:62）只对主库的
# geohot-worker 生效，而执行器跑的是本脚本（setup-executor-window.sh 装的就是它）。于是「夜里自动开
# 英文」在执行器上并不存在，反过来手工改了 .env 也没有任何东西会在早上把它关掉，正是 hcss 08:13 之后
# 一直 ENGLISH_CONCURRENCY=0、InstaBox 连 GEOHOT_INTAKE_ENGLISH_SLOTS 都没有的那种漂移。
# 两个键与 ENGLISH_CONCURRENCY 门必须成套：只有并发没有 intake 名额 = 每次领取都被判忙且零日志。
english=${GEOHOT_ROLE_ENGLISH_SLOTS:-0}
if [ "$mode" = "day" ]; then english=0; fi
set_key GEOHOT_INTAKE_ENGLISH_SLOTS "$english"
set_key ENGLISH_CONCURRENCY "$english"

logger -t geohot-role "mode=$mode role=$role slots=$slots english=$english file=$env_file"

# worker 要重启才会读到新的 role（job 分组在启动时决定）。
systemctl restart --no-block geohot-exec-worker 2>/dev/null || systemctl restart --no-block geohot-worker 2>/dev/null || true
echo "mode=$mode role=$role slots=$slots english=$english"
