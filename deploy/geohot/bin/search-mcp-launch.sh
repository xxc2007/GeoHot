#!/usr/bin/env bash
# search-mcp-launch.sh — 服务器端 search MCP stdio 子进程包装器（预留，当前未启用）
#
# 状态（2026-11-16）：packages/backend/src/sources/search-providers.ts 当前直接 HTTP 调用
# keyless provider（ddg-lite），尚未 spawn MCP。本脚本是未来迁移到 MCP stdio 子进程的
# 部署骨架，默认 GEOHOT_SEARCH_MCP_ENABLED=0 不执行任何操作。
#
# 设计约束：
#   - stdio JSON-RPC，不监听任何 TCP 端口，不暴露公共网络；
#   - 若启用，由 worker 进程 spawn，生命周期跟随 worker；
#   - Node V8 heap 硬限 128MB（worker cgroup MemoryMax=150M，heap 须留足原生余量）；
#   - MCP_BROWSER_FETCH=false：不启动无头 Chrome，不依赖本机浏览器/Cookie；
#   - 搜索超时 15s、fetch 超时 20s、并发 ≤2：891MB 机器上不压垮 Postgres/Magpie；
#   - 默认仅暴露 ddg-lite（keyless）；Bing 因 ToS 未确认，不默认启用；
#   - keyed 引擎的 API key 从私有 /etc/geohot/search-mcp.env 读取，本脚本不写死。
#
# 退出码语义：
#   - GEOHOT_SEARCH_MCP_ENABLED!=1（默认）：exit 0，静默跳过（不输出错误）；
#   - ENABLED=1 但 MCP_BIN 不存在：exit 1，明确失败（不隐藏故障）；
#   - ENABLED=1 且 MCP_BIN 存在：exec node，正常运行。
set -euo pipefail

# ---- 灰度开关：默认关闭 ----
if [[ "${GEOHOT_SEARCH_MCP_ENABLED:-0}" != "1" ]]; then
  exit 0
fi

# ---- 资源限制（Node V8 堆）----
# worker cgroup MemoryMax=150M；heap 128M 留 22M 给原生/栈/外部内存。
export NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=4"

# ---- MCP 行为约束 ----
export MCP_BROWSER_FETCH="${MCP_BROWSER_FETCH:-false}"
export MCP_SEARCH_TIMEOUT_MS="${MCP_SEARCH_TIMEOUT_MS:-15000}"
export MCP_FETCH_TIMEOUT_MS="${MCP_FETCH_TIMEOUT_MS:-20000}"
export MCP_MAX_CONCURRENCY="${MCP_MAX_CONCURRENCY:-2}"
# 默认 provider 列表为空：DDG-lite/Bing 均未获 ToS 授权用于服务器端自动化，
# 需信源侧逐引擎确认授权后在 /etc/geohot/search-mcp.env 中显式开启。
export MCP_ENABLED_PROVIDERS="${MCP_ENABLED_PROVIDERS:-}"

# ---- MCP 二进制路径 ----
MCP_BIN="${GEOHOT_SEARCH_MCP_BIN:-/opt/geohot/search-mcp/bin/mcp.js}"

if [[ ! -f "$MCP_BIN" ]]; then
  echo "search-mcp: ENABLED=1 but $MCP_BIN not found — refusing to silently degrade" >&2
  exit 1
fi

# 私有 key 文件（如果存在）；不存在则只用 keyless provider
if [[ -f /etc/geohot/search-mcp.env ]]; then
  # shellcheck disable=SC1091
  set -a; source /etc/geohot/search-mcp.env; set +a
fi

exec node "$MCP_BIN"
