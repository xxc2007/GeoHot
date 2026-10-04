#!/usr/bin/env bash
# verify-deploy.sh — GEOHOT 上线后只读验证。任何断言失败 ⇒ 非零退出。
# 不做任何写操作、不重启任何服务。检查面改编自 DEPLOY-PLAN §7，全部对齐代码实测路径。
#
# ★★ 先Baseline再部署 ★★
#   改动 nginx 之前必须先跑一次:  bash verify-deploy.sh --save-baseline
#   它会把主站首页与主站 sitemap 的 sha256 记到 deploy/geohot/baseline-main.txt。
#   部署后跑:  bash verify-deploy.sh          —— 逐项断言并比对基线。
#   只想更新基线（确认主站本来就变了）：重新 --save-baseline 并写明原因。
#   基线文件按 key=value 逐行读（不 source）：少一个键就是少一个键，不能让整个脚本以 unbound variable 死掉。
#
# 可用的环境变量:
#   GEOHOT_BASE / MAIN_SITE / GEOHOT_BASE_PATH / BASELINE_FILE / GEOHOT_APP_ROOT
#   GEOHOT_DEPLOYED_AT=<上线日，date -d 认的任意写法>
#     第 7 节用它判断"上线后的第一个 08:00 档期到没到"：没到（或没给）时日报/热榜为空只记 note，
#     过了就变成硬失败。上线当天这两项本来就是空的（见 README-deploy.md 第 0 节决定 1 与
#     DEPLOYMENT.md「还没做的」第一条），不给这个变量又不许它红，才是对这台机器诚实的做法。
set -uo pipefail   # 不用 -e：要收集所有失败再统一退出

BASE="${GEOHOT_BASE:-https://xxc2007.me/geohot}"
# Asset hrefs scraped from the page already carry the prefix, so they are requested against the origin.
# Appending them to $BASE produced /geohot/geohot/assets/… and failed a correct deployment.
ORIGIN=$(printf '%s' "$BASE" | sed -E 's#^(https?://[^/]+).*#\1#')
MAIN="${MAIN_SITE:-https://xxc2007.me}"
# 站点前缀跟着 BASE 走，两处不可能对不上（要单独指定就设 GEOHOT_BASE_PATH；根路径部署留空）。
# 下面第 3、4 节那些断言曾经把 /geohot 写死在 grep 里，那对根路径部署是必然红的。
host_part="${BASE#*://}"; base_path=""
[[ "$host_part" == */* ]] && base_path="/${host_part#*/}"
PREFIX="${GEOHOT_BASE_PATH-$base_path}"
PREFIX="${PREFIX%/}"; [[ -n "$PREFIX" ]] && PREFIX="/${PREFIX#/}"   # 归一化："" 或 /geohot
UA="Mozilla/5.0 (Windows NT 10.0) Chrome/126"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASELINE_FILE="${BASELINE_FILE:-$HERE/baseline-main.txt}"
# One install path for the whole deploy package (GEOHOT_APP_ROOT; bootstrap / install-units / rollback and
# the systemd/ templates all default to the same value).
APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
FAILS=0
FAIL_LIST=()

ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*" >&2; FAILS=$((FAILS+1)); FAIL_LIST+=("$*"); }
note() { echo "  · $*"; }

status_of() { curl -s -A "$UA" -o /dev/null -w '%{http_code}' --max-time 30 "$1"; }

# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--save-baseline" ]]; then
  echo "记录主站基线（部署前必做，只读）: $BASELINE_FILE"
  {
    echo "main_home_sha256=$(curl -s -A "$UA" "$MAIN/" | sha256sum | cut -d' ' -f1)"
    echo "main_sitemap_sha256=$(curl -s -A "$UA" "$MAIN/sitemap.xml" | sha256sum | cut -d' ' -f1)"
    echo "captured_at=$(date -u +%FT%TZ)"
  } > "$BASELINE_FILE"
  cat "$BASELINE_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
echo "== 1. 主站未受影响（与部署前基线比对）=="
if [[ -f "$BASELINE_FILE" ]]; then
  # 基线文件是给人看的 key=value，不是脚本；source 它有两个毛病：① 缺键时下面那些
  # ${main_home_sha256:0:12} 会在 set -u 下直接以"unbound variable"死掉 —— 报告变成"脚本自己炸了"，
  # 而真相是"基线里没有这一项"；② source 等于执行别人的文件。所以按键读出来，读不到就是空串。
  baseline_get() { # baseline_get <KEY> —— 没有这个键 / 文件读不到 ⇒ 空串（绝不 unbound）
    local line
    line="$(grep -m1 -E "^[[:space:]]*$1[[:space:]]*=" "$BASELINE_FILE" 2>/dev/null | tr -d '\r' || true)"
    printf '%s' "${line#*=}"
  }
  base_home="$(baseline_get main_home_sha256)"
  base_sitemap="$(baseline_get main_sitemap_sha256)"
  base_at="$(baseline_get captured_at)"
  if [[ -z "$base_home" && -z "$base_sitemap" ]]; then
    bad "基线文件 $BASELINE_FILE 里既没有 main_home_sha256 也没有 main_sitemap_sha256 —— 这不是\"主站变了\"，是基线根本没记上（被截断？手改过？）。重新跑 bash verify-deploy.sh --save-baseline"
  fi
  [[ -n "$base_at" ]] && note "基线采集于 $base_at" || note "基线没有 captured_at 这一行（旧版格式，或写入时被打断）"
  now_home=$(curl -s -A "$UA" "$MAIN/" | sha256sum | cut -d' ' -f1)
  if [[ -z "$base_home" ]]; then
    bad "主站首页无法比对：基线缺 main_home_sha256（现在=${now_home:0:12}…）"
  elif [[ "$now_home" == "$base_home" ]]; then ok "主站首页字节级一致（sha256=${now_home:0:12}…）"
  else bad "主站首页哈希变了！基线=${base_home:0:12}… 现在=${now_home:0:12}… —— 立即执行 rollback.sh"; fi
  now_sm=$(curl -s -A "$UA" "$MAIN/sitemap.xml" | sha256sum | cut -d' ' -f1)
  if [[ -z "$base_sitemap" ]]; then
    bad "主站 sitemap 无法比对：基线缺 main_sitemap_sha256（现在=${now_sm:0:12}…）"
  elif [[ "$now_sm" == "$base_sitemap" ]]; then ok "主站 sitemap 一致"
  else bad "主站 sitemap 哈希变了（基线=${base_sitemap:0:12}… 现在=${now_sm:0:12}…；基线已失效？先人工确认再更新基线）"; fi
else
  bad "没有基线文件 $BASELINE_FILE —— 无法证明主站未受影响。部署前应先 --save-baseline。"
fi
[[ "$(status_of "$MAIN/")" == "200" ]] && ok "主站 200" || bad "主站首页非 200"
# Artalk（systemd + SQLite 自托管）反代照旧
artalk=$(status_of "$MAIN/comment/")
[[ "$artalk" =~ ^(200|301|302|404)$ ]] && ok "Artalk /comment/ 返回 $artalk（在既有语义内）" || bad "Artalk /comment/ 返回 $artalk —— 可能被新 nginx 片段遮断"

# ---------------------------------------------------------------------------
echo "== 2. GEOHOT 路由状态（前缀下）=="
# 常驻单元：DEPLOYMENT.md:10 记的是四个（brain/api/worker/web）。少一个 geohot-brain 不是"少个可选进程"，
# 而是 config.ts:92 的 MODEL_CALLS_ENABLED 缺省 true 之下每一次分析请求都打到没人听的 127.0.0.1:3055。
if command -v systemctl >/dev/null 2>&1 && [[ -n "$(systemctl list-unit-files 'geohot-*' --no-legend 2>/dev/null)" ]]; then
  for u in geohot-brain geohot-api geohot-worker geohot-web; do
    state=$(systemctl is-active "$u" 2>/dev/null || true)
    [[ "$state" == "active" ]] && ok "$u active" || bad "$u 状态=$state —— 四个单元都要 active（见 deploy/geohot/systemd/）"
  done
fi
# 编辑大脑的代码是不是"进程里那一份"。
# 2026-10-04 的真实漏检：geohot-brain 从 2026-10-01 16:17 起一直是 active，而这三天里
# tooling/brain-stub.ts 被改过两次（f35da0a 2026-10-02、c9f893b 2026-10-03）。Node 启动时把整个
# .ts 读进内存，所以进程一直在跑旧代码：summarize 缺人工稿时的默认值还是 condense，于是它把**英文
# 原标题与英文正文的机械截断**写进 title_zh / summary_zh（analyze.ts 的中文闸门因此形同虚设），
# 每天一两百到五百条条目带着拉丁文标题留在库里。单元是 active、healthz 是 200、日志没有 error——
# 状态码这一类断言全绿，而行为是错的。
# 唯一可靠的判据是内容哈希：进程在 healthz 里报出**它启动时读进内存那份代码**的 sha256
# （tooling/brain-stub.ts 的 SOURCE_SHA256），这里拿磁盘上的同一文件重算一次比对。不一致就是跑旧代码。
# 不用 mtime 比较：`git archive` 给整棵树盖上的是**提交时刻**，整包升级后源码 mtime 必然晚于进程
# 启动时刻，用"源码比进程新"判会每次部署都误报。
brain_hz="$(curl -s --max-time 10 http://127.0.0.1:3055/healthz || true)"
brain_sha="$(printf '%s' "$brain_hz" | tr -d ' \n' | grep -oE '"sha256":"[0-9a-f]{64}"' | head -1 | sed -E 's/.*:"([0-9a-f]{64})"/\1/')"
if [[ -z "$brain_sha" ]]; then
  note "brain healthz 没报 source.sha256（stub 没答？或版本太旧），跳过这一条"
else
  disk_sha="$(sha256sum "$APP_ROOT/tooling/brain-stub.ts" 2>/dev/null | cut -d' ' -f1)"
  if [[ -z "$disk_sha" ]]; then
    note "读不到 $APP_ROOT/tooling/brain-stub.ts，无法比对 brain 代码指纹"
  elif [[ "$brain_sha" == "$disk_sha" ]]; then
    ok "geohot-brain 跑的就是磁盘上这份代码（sha256=${brain_sha:0:12}…）"
  else
    bad "geohot-brain 在跑旧代码：healthz 自报 ${brain_sha:0:12}…，磁盘上是 ${disk_sha:0:12}…。Node 不热更新自己的代码，必须 sudo systemctl restart geohot-brain —— 2026-10-04 就是这样让旧默认值 condense 把英文原标题写进 title_zh、并让公开池里出现整条英文卡片的"
  fi
fi
# 出货契约：stub 只回空稿、等人工中文稿。condense/echo 是开发与测试显式打开的（tooling/brain-stub.ts:32-41
# 记着 2026-10-02 那次"中文站出现整条英文卡片"的事故）。生产上这一项必须是 empty。
hz_sum="$(printf '%s' "$brain_hz" | tr -d ' \n' | grep -oE '"summarize":"[a-z]+"' | head -1 | sed -E 's/.*:"([a-z]+)"/\1/')"
if [[ -z "$hz_sum" ]]; then
  note "读不到 brain healthz 的 defaults.summarize（stub 没在 127.0.0.1:3055 上答？），跳过这一条"
elif [[ "$hz_sum" == "empty" ]]; then
  ok "brain 缺人工稿时回空稿（summarize=empty）"
else
  bad "brain 的 summarize 默认值是 $hz_sum，不是 empty —— 生产上它会把英文原标题/正文截断成 title_zh / summary_zh，中文闸门形同虚设（见 tooling/brain-stub.ts:32-41 记的线上事故）"
fi
for p in / /all /hot /daily /about /agent /terms /privacy /admin/login /feed.xml /sitemap.xml /llms.txt /openapi-v1.json /manifest.webmanifest /og/site.png /icon.png; do
  code=$(status_of "$BASE$p")
  case "$p" in
    /admin/login) want='^(200|30[1278])$' ;;   # 登录页存在（重定向也接受）
    *)            want='^200$' ;;
  esac
  if [[ "$code" =~ $want ]]; then ok "$p -> $code"; else bad "$p -> $code（期望 $want）"; fi
done
hc=$(curl -s -A "$UA" --max-time 15 "$BASE/api/health")
echo "$hc" | grep -q '"ok":true' && echo "$hc" | grep -q '"db":"ok"' && ok "/api/health $hc" || bad "/api/health 异常: $hc"
# 裸前缀（无尾斜杠）：nginx 里那条 `location = $PREFIX` 的 308 是承重的（fix-bare-path.sh 里那段
# "the trailing-slash redirect is load-bearing"的注释和它插入的 exact-match 块），
# 客户端路由的 basename 匹配不了裸路径，只在服务端 SSR 是好的。跟随后要 200、跳转 ≤1、且落在 https 上
# （`return 308 https://$host/...` 写死了 scheme，明文 staging vhost 会在这一点断掉 —— 见片段里那条
# "⚠️ 代价：scheme 写死成 https"的注释）。
if [[ -n "$PREFIX" ]]; then
  bare=$(curl -s -A "$UA" -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}' -L --max-time 30 "$MAIN$PREFIX")
  if [[ "$bare" =~ ^200\ [01]\ https:// ]]; then ok "裸 $PREFIX -> ${bare}（补斜杠由 nginx 做）"
  else bad "裸 $PREFIX -> $bare（期望 200、跳转 ≤1、https 收尾；缺的是 geohot.nginx.conf片段 里那条 location = /geohot 的 308 —— 它把目标写死成 https，见该片段与 fix-bare-path.sh）"; fi
else
  note "域名根部署（GEOHOT_BASE_PATH=\"\"）：没有裸前缀要补斜杠，跳过这一条"
fi

# ---------------------------------------------------------------------------
echo "== 3. 页面内资源 URL 全部落在前缀下 =="
page=$(curl -s -A "$UA" --max-time 30 "$BASE/")
if [[ -z "$PREFIX" ]]; then
  note "跳过根绝对检查：域名根部署的资源本来就以 / 开头，没有前缀可比"
else
  root_abs=$(echo "$page" | grep -Eo '(href|src)="/[^"]*"' | grep -vE "(href|src)=\"$PREFIX" || true)
  if [[ -z "$root_abs" ]]; then ok "无根绝对 href/src"
  else bad "发现逃出前缀的绝对资源（构建没带 BASE_PATH=$PREFIX？）:"; echo "$root_abs" | head -10 | sed 's/^/      /'; fi
fi
# 抽前 8 个前缀下的资源实际请求一遍（这一条就是"HTML 200、每个 css/js 都 404"的那个网）
if [[ -n "$PREFIX" ]]; then
res=$(echo "$page" | grep -Eo "(href|src)=\"$PREFIX/[^\"]*\"" | sed -E 's/.*"([^"]*)".*/\1/' | grep -E "^$PREFIX/(assets|_routes)" | head -8)
if [[ -z "$res" ]]; then note "页面里没抽到 $PREFIX/assets 资源（若改造走 <Links/> 注入属正常，跳过）"
else
  for r in $res; do
    c=$(status_of "${ORIGIN}$r"); [[ "$c" == "200" ]] && ok "asset $r -> 200" || bad "asset $r -> $c"
  done
fi
else
  res=$(echo "$page" | grep -Eo '(href|src)="/(assets|_routes)/[^"]*"' | sed -E 's/.*"([^"]*)".*/\1/' | head -8)
  for r in $res; do
    c=$(status_of "${ORIGIN}$r"); [[ "$c" == "200" ]] && ok "asset $r -> 200" || bad "asset $r -> $c"
  done
fi

# ---------------------------------------------------------------------------
echo "== 4. feeds / sitemap 的 <loc> 带前缀 =="
site_host="${BASE#*://}"; site_host="${site_host%%/*}"
site_host_re="${site_host//./\\.}"        # 点要转义，否则 host 里任何一个字符都算匹配
for f in /feed.xml /sitemap.xml /llms.txt; do
  body=$(curl -s -A "$UA" --max-time 30 "$BASE$f")
  hosts=$(echo "$body" | grep -Eo 'https?://[a-zA-Z0-9.-]+' | sort -u | tr '\n' ' ')
  echo "$hosts" | grep -qF "$site_host" && ok "$f 引用域名: $hosts" || bad "$f 没有任何 $site_host 链接"
  if [[ "$f" == "/llms.txt" ]]; then
    if [[ -z "$PREFIX" ]]; then note "llms.txt：域名根部署，前缀断言不适用（只比域名）"
    elif echo "$body" | grep -qF "$PREFIX"; then ok "llms.txt 链接带前缀 $PREFIX"
    else bad "llms.txt 链接不带 $PREFIX（SITE_URL 没设对？config.ts:54-68）"; fi
  else
    # RSS carries its URLs in <link>, <loc> is the sitemap's element — counting only the second made a
    # correct feed read as "0 links".
    n_all=$(echo "$body" | grep -Eo '<(loc|url|link)>[^<]+' | wc -l)
    n_pre=$(echo "$body" | grep -Eo "<(loc|url|link)>https://${site_host_re}${PREFIX}" | wc -l)
    [[ "$n_all" -gt 0 && "$n_all" -eq "$n_pre" ]] && ok "$f：$n_pre/$n_all 条链接全部落在 https://${site_host}${PREFIX}" || bad "$f：带前缀 $n_pre / 共 $n_all"
  fi
done

# ---------------------------------------------------------------------------
echo "== 5. 后台鉴权：/api/admin/* 必须 401（DEV_AUTH 后门已摘）=="
for p in /api/admin/sources /api/admin/runs /api/admin/monitor/events; do
  c=$(status_of "$BASE$p")
  if [[ "$c" == "401" || "$c" == "403" ]]; then ok "$p -> $c"
  # /api/admin/monitor/* is an AI-only module: with industry/features.ts codexResetMonitor off the routes
  # are never registered (apps/api/src/routes/admin.ts:99-103), so 404 is that module's own gate, not a
  # routing failure. The two always-registered paths above still have to answer 401.
  elif [[ "$p" == "/api/admin/monitor/events" && "$c" == "404" ]]; then note "$p -> 404（codexResetMonitor 关闭，路由未注册，与 api 的 registerLeaderboard 那一道同一开关：apps/api/src/routes/admin.ts 的 if (FEATURES.codexResetMonitor) 与 apps/api/src/app.ts 的 if (FEATURES.leaderboard)）"
  else bad "$p -> $c（期望 401/403；404 也可能是剥前缀路由问题）"; fi
done

# ---------------------------------------------------------------------------
echo "== 6. MCP：initialize 不得 421（host 锁只比 hostname：apps/api/src/routes/mcp.ts 的 SITE_HOST / ALLOWED_HOSTS，421 在 ALLOWED_HOSTS.has(host) 那一行）=="
mcp_http=$(curl -s -o /tmp/geohot_mcp.$$ -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' \
  --max-time 30 "$BASE/api/mcp")
body_head=$(head -c 160 /tmp/geohot_mcp.$$ 2>/dev/null); rm -f /tmp/geohot_mcp.$$
if [[ "$mcp_http" == "421" ]]; then bad "MCP 421 misdirected（X-Forwarded-Host/Host 传递有误？见 nginx 片段 proxy_set_header Host）"
elif [[ "$mcp_http" == "200" || "$mcp_http" == "206" ]]; then ok "MCP initialize -> $mcp_http: ${body_head:0:120}"
else bad "MCP initialize -> $mcp_http: $body_head"; fi
# DELETE 会话与 OPTIONS 预检在方法集里（mcp.ts:293-299），PUT 应 405
c=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: https://xxc2007.me' --max-time 15 "$BASE/api/mcp")
[[ "$c" == "204" ]] && ok "MCP OPTIONS -> 204" || bad "MCP OPTIONS -> $c（期望 204，mcp.ts:298）"
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT --max-time 15 "$BASE/api/mcp")
[[ "$c" == "405" ]] && ok "MCP PUT -> 405" || bad "MCP PUT -> $c（期望 405，mcp.ts:300-305）"

# ---------------------------------------------------------------------------
echo "== 7. 内容面：日报、热榜、快照计数 =="
# 上线当天后两项**本来就该是空的**，把它们算成红会把一次正确的部署判成失败：
#   · reports.daily 的档期是 0 8 * * *（Asia/Shanghai，见 apps/worker/src/schedules.ts 的 SCHEDULES 表）。
#     DEPLOYMENT.md「还没做的」第一条记的就是这个：worker 在 16:17 才起，当天 08:00 那一档已经过了。
#   · 热榜要的是被归进同一事件的多条材料；新库里未筛选的默认 UNRELATED（README-deploy.md 第 0 节决定 1）。
# 只有"这台机器已经跑过了它上线之后的第一个 08:00"，空日报才是真故障。判断要知道上线时刻，
# 而那件事 HTTP 面查不到 —— 所以由 GEOHOT_DEPLOYED_AT 显式给（date -d 认的任意写法，如 2026-10-02）。
# 没给就退回 note 并说清"不是不查，是查不到"，不假装知道。
content_expected=0
if [[ -z "${GEOHOT_DEPLOYED_AT:-}" ]]; then
  content_reason="没有 GEOHOT_DEPLOYED_AT —— 无法判断上线后的第一个 08:00 档期到没到，这项只记 note。要它变成硬断言：GEOHOT_DEPLOYED_AT=2026-10-01 bash verify-deploy.sh"
else
  deployed_epoch="$(date -d "$GEOHOT_DEPLOYED_AT" +%s 2>/dev/null || true)"
  bj_hour="$(TZ=Asia/Shanghai date +%-H 2>/dev/null || true)"
  today_eight="$(TZ=Asia/Shanghai date -d "today 08:00" +%s 2>/dev/null || true)"
  if [[ ! "$deployed_epoch" =~ ^[0-9]+$ ]]; then
    content_reason="GEOHOT_DEPLOYED_AT='$GEOHOT_DEPLOYED_AT' 本机 date 解析不了，这项只记 note"
  elif [[ ! "$bj_hour" =~ ^[0-9]+$ || ! "$today_eight" =~ ^[0-9]+$ ]]; then
    content_reason="算不出北京时间的 08:00 边界（date 不支持 TZ=/-d？），这项只记 note"
  else
    # 最近一个**已经过去**的北京 08:00：现在不到 8 点就是昨天那一档，否则就是今天这一档。
    if (( 10#$bj_hour < 8 )); then cutoff=$(( today_eight - 86400 )); else cutoff=$today_eight; fi
    cutoff_h="$(TZ=Asia/Shanghai date -d "@$cutoff" +'%F %H:%M' 2>/dev/null || echo '?')"
    if (( deployed_epoch <= cutoff )); then
      content_expected=1
      content_reason="上线于 $GEOHOT_DEPLOYED_AT，最近一档 $cutoff_h 已经过去 → 空日报/空热榜算硬失败"
    else
      content_reason="上线于 $GEOHOT_DEPLOYED_AT，最近一档 $cutoff_h 早于上线时刻 → 还没有 08:00 跑过，只记 note"
    fi
  fi
fi
snap=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/selected/snapshot")
cnt=$(echo "$snap" | grep -Eo '"count":[0-9]+' | head -1 | tr -dc 0-9)
# 这一项**不**跟着放宽：selected 是 seed:curated 当场灌进去的（bootstrap-server.sh 第 8 节），
# 上线那一刻就该有。它是"管道与语料到底通没通"的那个信号，空了就是真出事。
if [[ -n "${cnt:-}" && "$cnt" -ge 1 ]]; then ok "selected/snapshot count=$cnt"; else bad "selected/snapshot 无 count 或为 0（seed:curated 没进去？bootstrap 第 8 节）: ${snap:0:200}"; fi
# 载荷里的 category 必须落在当前词表内。这一项是照着一个真实的漏检补上的：
# 0040/0041 改词表时只 UPDATE 了 publications，而 v1 同步接口读的是 selected_ledger.payload
# 里写入时物化下来的那份拷贝（publish.ts 的 v1Payload + appendLedger）。于是网页全对、
# 公开 API 连着两天对外发已删除的分类 key，直到 2026-10-04 手工 curl 快照才发现。
# 判据不写死 key 表：从部署目录的 industry/taxonomy.ts 现读，词表再改也不会漏。
if [[ -f "$APP_ROOT/industry/taxonomy.ts" ]]; then
  cats=$(grep -oE '\{ key: "[a-z-]+"' "$APP_ROOT/industry/taxonomy.ts" | sed -E 's/.*"([a-z-]+)"/\1/' | sort -u | tr '\n' ' ')
  if [[ -n "$cats" ]]; then
    # 快照里每个 "category":"…" 的值都要在词表内；null 是允许的（未分类）。
    bad_cats=$(echo "$snap" | grep -oE '"category":[[:space:]]*"[a-z-]+"' | sed -E 's/.*"([a-z-]+)"$/\1/' | sort -u | grep -vxF -f <(printf '%s\n' $cats) || true)
    if [[ -z "$bad_cats" ]]; then
      ok "selected/snapshot 的分类都在词表内（$(echo $cats | wc -w) 个 key）"
    else
      # 这是硬失败：机器可读出口发着词表里不存在的分类，客户端只能照单全收。
      bad "selected/snapshot 里有词表外的分类：$(echo $bad_cats | tr '\n' ' ')——0040/0041 那类改词表的迁移漏了 selected_ledger.payload（补法见 0043 的注释）"
    fi
  fi
fi
if [[ "$content_expected" == "1" ]]; then content_check=bad; else content_check=note; fi
note "$content_reason"
daily=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/dailies/latest")
if echo "$daily" | grep -Eq '"sections":\s*\[\s*\{'; then
  ok "最新日报含非空 sections（/api/v1/dailies/latest，v1.ts:105）"
else
  $content_check "日报为空/缺 sections（reports.daily 的 08:00 档期没跑，或语料没进窗口？schedules.ts 的 reports.daily 那一行）: ${daily:0:200}"
fi
hot=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/hot-topics")
if echo "$hot" | grep -Eq '"items":\s*\[\s*\{'; then
  ok "热榜非空（/api/v1/hot-topics，v1.ts:80）"
else
  $content_check "热榜为空（新料默认 UNRELATED，要 fixture 判断覆盖 —— README-deploy.md 第 0 节决定 1 与故障表那一行）: ${hot:0:200}"
fi
[[ "$content_check" == "note" ]] && note "上面两项按 note 处理；确认已过第一个 08:00 还空着，就带 GEOHOT_DEPLOYED_AT=<上线日> 重跑，它们会变成硬失败"

# ---------------------------------------------------------------------------
echo "== 8. 仓库自带冒烟（只读，15 页 + 15 机器出口，scripts/smoke.ts:12 含 /api/health）=="
if command -v node >/dev/null 2>&1 && [[ -f "$APP_ROOT/scripts/smoke.ts" ]]; then
  if (cd "$APP_ROOT" && node scripts/smoke.ts --base "$BASE"); then ok "smoke.ts 全绿"; else bad "smoke.ts 有失败项（见上方输出）"; fi
else
  note "跳过：本机没有 node 或缺 $APP_ROOT/scripts/smoke.ts（在服务器上跑才有效）"
fi

# ---------------------------------------------------------------------------
echo
if [[ "$FAILS" -gt 0 ]]; then
  echo "RESULT: FAIL（$FAILS 项）"
  printf '  - %s\n' "${FAIL_LIST[@]}"
  exit 1
fi
echo "RESULT: ALL CHECKS PASSED"
