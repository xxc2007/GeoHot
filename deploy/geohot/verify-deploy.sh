#!/usr/bin/env bash
# verify-deploy.sh — GEOHOT 上线后只读验证。任何断言失败 ⇒ 非零退出。
# 不做任何写操作、不重启任何服务。检查面改编自 DEPLOY-PLAN §7，全部对齐代码实测路径。
#
# ★★ 先Baseline再部署 ★★
#   改动 nginx 之前必须先跑一次:  bash verify-deploy.sh --save-baseline
#   它会把主站首页与主站 sitemap 的 sha256 记到 deploy/geohot/baseline-main.txt。
#   部署后跑:  bash verify-deploy.sh          —— 逐项断言并比对基线。
#   只想更新基线（确认主站本来就变了）：重新 --save-baseline 并写明原因。
set -uo pipefail   # 不用 -e：要收集所有失败再统一退出

BASE="${GEOHOT_BASE:-https://xxc2007.me/geohot}"
MAIN="${MAIN_SITE:-https://xxc2007.me}"
UA="Mozilla/5.0 (Windows NT 10.0) Chrome/126"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASELINE_FILE="${BASELINE_FILE:-$HERE/baseline-main.txt}"
REPO_DIR="${REPO_DIR:-/opt/geohot/GEOHOT}"
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
  # shellcheck disable=SC1090
  source "$BASELINE_FILE"
  now_home=$(curl -s -A "$UA" "$MAIN/" | sha256sum | cut -d' ' -f1)
  if [[ "$now_home" == "${main_home_sha256:-}" ]]; then ok "主站首页字节级一致（sha256=${now_home:0:12}…）"
  else bad "主站首页哈希变了！基线=${main_home_sha256:0:12}… 现在=${now_home:0:12}… —— 立即执行 rollback.sh"; fi
  now_sm=$(curl -s -A "$UA" "$MAIN/sitemap.xml" | sha256sum | cut -d' ' -f1)
  [[ "$now_sm" == "${main_sitemap_sha256:-}" ]] && ok "主站 sitemap 一致" || bad "主站 sitemap 哈希变了（基线已失效？先人工确认再更新基线）"
else
  bad "没有基线文件 $BASELINE_FILE —— 无法证明主站未受影响。部署前应先 --save-baseline。"
fi
[[ "$(status_of "$MAIN/")" == "200" ]] && ok "主站 200" || bad "主站首页非 200"
# Artalk（systemd + SQLite 自托管）反代照旧
artalk=$(status_of "$MAIN/comment/")
[[ "$artalk" =~ ^(200|301|302|404)$ ]] && ok "Artalk /comment/ 返回 $artalk（在既有语义内）" || bad "Artalk /comment/ 返回 $artalk —— 可能被新 nginx 片段遮断"

# ---------------------------------------------------------------------------
echo "== 2. GEOHOT 路由状态（前缀下）=="
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

# ---------------------------------------------------------------------------
echo "== 3. 页面内资源 URL 全部落在前缀下 =="
page=$(curl -s -A "$UA" --max-time 30 "$BASE/")
root_abs=$(echo "$page" | grep -Eo '(href|src)="/[^"]*"' | grep -vE '(href|src)="/geohot' || true)
if [[ -z "$root_abs" ]]; then ok "无根绝对 href/src"
else bad "发现根绝对资源（子路径改造未完成/构建未带 base）:"; echo "$root_abs" | head -10 | sed 's/^/      /'; fi
# 抽前 8 个 /geohot/ 资源实际请求一遍
res=$(echo "$page" | grep -Eo '(href|src)="/geohot/[^"]*"' | sed -E 's/.*"([^"]*)".*/\1/' | grep -E '^/geohot/(assets|_routes)' | head -8)
if [[ -z "$res" ]]; then note "页面里没抽到 /geohot/assets 资源（若改造走 <Links/> 注入属正常，跳过）"
else
  for r in $res; do
    c=$(status_of "${BASE%/}$r"); [[ "$c" == "200" ]] && ok "asset $r -> 200" || bad "asset $r -> $c"
  done
fi

# ---------------------------------------------------------------------------
echo "== 4. feeds / sitemap 的 <loc> 带前缀 =="
for f in /feed.xml /sitemap.xml /llms.txt; do
  body=$(curl -s -A "$UA" --max-time 30 "$BASE$f")
  hosts=$(echo "$body" | grep -Eo 'https?://[a-zA-Z0-9.-]+' | sort -u | tr '\n' ' ')
  echo "$hosts" | grep -q 'xxc2007.me' && ok "$f 引用域名: $hosts" || bad "$f 没有任何 xxc2007.me 链接"
  if [[ "$f" == "/llms.txt" ]]; then
    echo "$body" | grep -q '/geohot' && ok "llms.txt 链接带前缀" || bad "llms.txt 链接不带 /geohot（SITE_URL 没设对？config.ts:42）"
  else
    n_all=$(echo "$body" | grep -Eo '<(loc|url)>[^<]+' | wc -l)
    n_pre=$(echo "$body" | grep -Eo '<(loc|url)>https://xxc2007\.me/geohot' | wc -l)
    [[ "$n_all" -gt 0 && "$n_all" -eq "$n_pre" ]] && ok "$f：$n_pre/$n_all 条链接全部带 /geohot" || bad "$f：带前缀 $n_pre / 共 $n_all"
  fi
done

# ---------------------------------------------------------------------------
echo "== 5. 后台鉴权：/api/admin/* 必须 401（DEV_AUTH 后门已摘）=="
for p in /api/admin/sources /api/admin/runs /api/admin/monitor/events; do
  c=$(status_of "$BASE$p")
  [[ "$c" == "401" || "$c" == "403" ]] && ok "$p -> $c" || bad "$p -> $c（期望 401/403；404 也可能是剥前缀路由问题）"
done

# ---------------------------------------------------------------------------
echo "== 6. MCP：initialize 不得 421（host 锁只比 hostname，mcp.ts:219-220,254-255）=="
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
echo "== 7. 内容面：日报非空、热榜非空、快照计数 =="
snap=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/selected/snapshot")
cnt=$(echo "$snap" | grep -Eo '"count":[0-9]+' | head -1 | tr -dc 0-9)
if [[ -n "${cnt:-}" && "$cnt" -ge 1 ]]; then ok "selected/snapshot count=$cnt"; else bad "selected/snapshot 无 count 或为 0: ${snap:0:200}"; fi
daily=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/dailies/latest")
echo "$daily" | grep -Eq '"sections":\s*\[\s*\{' \
  && ok "最新日报含非空 sections（/api/v1/dailies/latest，v1.ts:105）" || bad "日报为空/缺 sections（reports.daily 08:00 未跑或语料没进窗口？schedules.ts:46）: ${daily:0:200}"
hot=$(curl -s -A "$UA" --max-time 30 "$BASE/api/v1/hot-topics")
echo "$hot" | grep -Eq '"items":\s*\[\s*\{' && ok "热榜非空（/api/v1/hot-topics，v1.ts:80）" || bad "热榜为空（归组默认 UNRELATED —— 需要 fixture 判断覆盖，见 README-deploy.md 故障表）: ${hot:0:200}"

# ---------------------------------------------------------------------------
echo "== 8. 仓库自带冒烟（只读，15 页 + 15 机器出口，scripts/smoke.ts:12 含 /api/health）=="
if command -v node >/dev/null 2>&1 && [[ -f "$REPO_DIR/scripts/smoke.ts" ]]; then
  if (cd "$REPO_DIR" && node scripts/smoke.ts --base "$BASE"); then ok "smoke.ts 全绿"; else bad "smoke.ts 有失败项（见上方输出）"; fi
else
  note "跳过：本机没有 node 或缺 $REPO_DIR/scripts/smoke.ts（在服务器上跑才有效）"
fi

# ---------------------------------------------------------------------------
echo
if [[ "$FAILS" -gt 0 ]]; then
  echo "RESULT: FAIL（$FAILS 项）"
  printf '  - %s\n' "${FAIL_LIST[@]}"
  exit 1
fi
echo "RESULT: ALL CHECKS PASSED"
