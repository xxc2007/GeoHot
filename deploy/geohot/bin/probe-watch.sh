#!/bin/sh
# 一条连接干完启动期的活，或者一直循环采样。
#
# 为什么：服务器的 ufw 对 22/tcp 限 6 条/30 秒。本机辅助原先启动期要连打 4–5 条
# （采样、取维护权、取库凭据、建隧道、开采样会话），运行中每 10 秒再开一条，正好
# 压到额度上；被 DROP 之后一律表现为 `ssh: connect to host … port 22: Connection timed out`
# 或会话莫名关闭，supervisor 只能读成「证据丢失」（2026-11-04 现场）。
#
#   probe-watch.sh once     读一行 base64 载荷，依次输出三行 JSON：
#                             {"fence":…} {"probe":…} {"db":"postgres://…"}
#   probe-watch.sh <秒数>   读一行载荷后循环，每 <秒数> 秒输出一行 {"probe":…}
#
# 探针/维护锁失败直接退出，让 supervisor 立刻看到会话关闭，而不是静默重试。
set -u
MODE="${1:-10}"
# 循环必须有尽头（2026-11-06 现场）：一条 `while :; do …; sleep 10; done` 从后来被关掉的
# ssh 会话里漂出来，跑了 2 天 10 小时、写掉 66 GB 日志，把 891 MB 的机器反复打进 I/O 饥饿
# （`/proc/pressure/io` some avg10 长期 99%），读者面被打到 503/000。父会话没了就没人收尸，
# 所以这里自带寿命上限：默认 4 小时（一个白天/夜间辅助窗口的上限），要更久显式给更大的值。
MAX_SECONDS="${GEOHOT_PROBE_MAX_SECONDS:-14400}"
STARTED_AT="$(date +%s)"
APP=/opt/geohot/app/deploy/geohot

IFS= read -r PAYLOAD || exit 2
[ -n "${PAYLOAD}" ] || exit 2
export GEOHOT_PROBE_INPUT_B64="${PAYLOAD}"
unset PAYLOAD

# 每一步的输出都先收进变量再去掉尾部换行：python 的 print() 自带 \n，直接
# `printf '{"probe":'; probe; printf '}\n'` 会把 `}` 甩到下一行，supervisor 读到的
# 就是 `{"probe":{…}\n}` 这种不合法 JSON（2026-11-04 实测踩过）。
probe_json() { python3 "$APP/probe-extraction-assist.py"; }

if [ "${MODE}" = "once" ]; then
  # 维护权必须在探针之前：探针的 maintenance 判据看的是「owner 文件属于别人」，顺序反了
  # 就会把上一轮留下的自家陈锁读成外人占用（trial19 实证）。
  # JSON 用 python 拼：把 32 位会话令牌从 shell 插值里挪出去，否则一旦有引号/转义就变成
  # "invalid session token"；载荷是 base64，要先解码再取值。
  FENCE_JSON="$(python3 -c 'import base64,json,os;p=json.loads(base64.b64decode(os.environ["GEOHOT_PROBE_INPUT_B64"]));print(json.dumps({"action":"acquire","session":p.get("session") or ""}))')" || exit 3
  FENCE="$(printf '%s' "${FENCE_JSON}" | python3 "$APP/assist-maintenance-fence.py")" || exit 3
  printf '{"fence":%s}\n' "${FENCE}"

  PROBE="$(probe_json)" || exit 3
  printf '{"probe":%s}\n' "${PROBE}"

  DBCRED="$(cd /opt/geohot/app && sudo -n -u geohot node --env-file=.env --input-type=module -e 'console.log(JSON.stringify({databaseUrl:process.env.DATABASE_URL}))')" || exit 3
  DBURL="$(printf '%s' "${DBCRED}" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["databaseUrl"]))')" || exit 3
  printf '{"db":%s}\n' "${DBURL}"
  exit 0
fi

while :; do
  if [ "$(( $(date +%s) - STARTED_AT ))" -ge "${MAX_SECONDS}" ]; then
    # 到点自己走人，让 supervisor 读成「这段辅助结束」，而不是一条永远开着的管道。
    printf '{"probe":{"expired":true,"seconds":%s}}\n' "${MAX_SECONDS}"
    exit 0
  fi
  PROBE="$(probe_json)" || exit 3
  printf '{"probe":%s}\n' "${PROBE}"
  sleep "${MODE}"
done