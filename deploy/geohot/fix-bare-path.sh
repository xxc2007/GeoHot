#!/usr/bin/env bash
# fix-bare-path.sh — 给每一个挂了 /geohot 的 server 块补上那条 exact-match 308（默认 DRY-RUN）
#
# Fix #2 for the bare /geohot path — this replaces the "no redirect at all" attempt, which was wrong.
#
# The real defect: with React Router's basename set to /geohot, the URL must be /geohot/ (or a longer
# path under it). A bare /geohot renders fine on the server (SSR normalises it) but the client-side
# router cannot resolve it and falls through to the 404 route — which is exactly "the page loads once,
# then breaks after you navigate away and come back", because every sidebar link for the home tab is
# href="/geohot".
#
# So the trailing-slash redirect is load-bearing and must stay. What was wrong with the original was
# only its TARGET: `return 308 /geohot/` is built from the connection scheme, and since Cloudflare
# reaches the origin in plaintext the Location came out as http://. Spelling the scheme out fixes that
# without removing the normalisation.
#
# 用法:
#   bash fix-bare-path.sh                    # DRY-RUN：只报每个 server 块会做什么，不写盘、不 reload
#   bash fix-bare-path.sh --apply            # 备份 → 写入 → nginx -t → 通过才 reload（绝不 restart）
# 可用环境变量:
#   GEOHOT_BASE_PATH=/geohot                 要补的前缀；域名根部署写空串（那种部署根本不该有这一条）
#   GEOHOT_NGINX_SITE=/etc/nginx/sites-available/xxc2007.me   站点文件
#   GEOHOT_ALLOW_SINGLE_VHOST=1              确实只有一个 server 块挂了 /geohot 时，明确授权放行
#
# 这次修正的是"只插第一处"：上一版用 text.replace(anchor, block + anchor, 1)，只碰**第一个**
# `location ^~ /geohot`，而本包自己的规则（geohot.nginx.conf片段 头部硬约束 3）要求 :80 与 :443
# 两个 vhost 都有这组 location —— Cloudflare 是以 80 端口明文回源的。于是"跑过一次 fix-bare-path.sh"
# 会让两个 vhost 里只有一个带 308：从 :443 进来正常，公网走 :80 那条又是裸路径 404。现在按 server 块
# 逐个处理，并且只找到一个就大声拒绝。
set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "未知参数: $arg（可用: --apply）" >&2; exit 2 ;;
  esac
done

CONF="${GEOHOT_NGINX_SITE:-/etc/nginx/sites-available/xxc2007.me}"
# 与 bootstrap-server.sh 同一套归一化：去掉尾斜杠；`-` 而不是 `:-`，空串是合法取值（域名根部署）。
PREFIX="${GEOHOT_BASE_PATH-/geohot}"
PREFIX="${PREFIX%/}"
STAMP=$(date +%F-%H%M%S)
BAK="$CONF.bak-$STAMP"
ALLOW_SINGLE="${GEOHOT_ALLOW_SINGLE_VHOST:-0}"

if [[ ! -f "$CONF" ]]; then
  echo "!! 站点文件不存在: $CONF —— 用 GEOHOT_NGINX_SITE=<路径> 指对，或先按 README-deploy.md 第 2 节 ⑦ 贴片段。" >&2
  exit 1
fi
if [[ -z "$PREFIX" ]]; then
  echo "!! GEOHOT_BASE_PATH 是空串 = 域名根部署：没有裸前缀要补斜杠，这条 308 **不该**存在（片段头部第 4 条）。" >&2
  echo "   这个脚本只服务挂在子路径上的部署。要撤销已存在的这一条，就手工删它（备份 → nginx -t → reload）。" >&2
  exit 1
fi

echo "模式: $([[ $APPLY == 1 ]] && echo 'APPLY（真正改文件，改前备份、nginx -t 通过才 reload）' || echo 'DRY-RUN（只打印计划）')"
echo "站点文件: $CONF    前缀: $PREFIX"

# 工作目录只给自己可读：站点配置里可能有 upstream 地址之类的信息，别落到 /tmp 里人人能看的地方。
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/site.conf"
NEW="$WORK/site.new"
chmod 600 "$WORK"
if ! sudo cat "$CONF" > "$SRC" 2>/dev/null; then
  echo "!! 读不了 $CONF（sudo 不通？）" >&2
  exit 1
fi
chmod 600 "$SRC"

set +e
python3 - "$SRC" "$NEW" "$PREFIX" "$ALLOW_SINGLE" > "$WORK/report.txt" 2>&1 <<'PY'
import re, sys

src, dst, prefix, allow_single = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = open(src, encoding="utf-8").read()
lines = text.split("\n")

exact_re = re.compile(r"^(\s*)location\s*=\s*" + re.escape(prefix) + r"\s*\{")
main_re = re.compile(r"^(\s*)location\s*\^~\s*" + re.escape(prefix) + r"\s*\{")
server_re = re.compile(r"^(\s*)server\s*\{")
listen_re = re.compile(r"^\s*listen\b([^;]*);")


def code(line):
    """去掉行尾注释后的部分：注释里出现的 { } 不该影响花括号配平。"""
    return line.split("#", 1)[0]


# 按行扫一遍，用非注释部分的花括号配平切出顶层 server 块（http{} 在 nginx.conf 里，站点文件顶层就是 server）。
blocks = []          # [(start_line, end_line)]  end 是那个收尾 } 所在行
depth = 0
start = None
for i, line in enumerate(lines):
    c = code(line)
    if depth == 0 and server_re.match(c):
        start = i
    for ch in c:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                print("unbalanced braces at line %d -- refusing to touch this file" % (i + 1))
                sys.exit(1)
    if start is not None and depth == 0:
        blocks.append((start, i))
        start = None

if depth != 0:
    print("file ends with unbalanced braces (depth %d) -- refusing to touch it" % depth)
    sys.exit(1)

inserts = []         # 行号 -> 要插入的文本
bearing = []         # 带 geohot 那组 location 的 server 块
for b0, b1 in blocks:
    body = lines[b0:b1 + 1]
    has_main = any(main_re.match(code(l)) for l in body)
    if not has_main:
        continue
    listens = sorted({(m.group(1) or "").strip() or "(default :80)" for m in
                      (listen_re.match(code(l)) for l in body) if m})
    bearing.append((b0, b1, listens))
    has_exact = any(exact_re.match(code(l)) for l in body)
    if has_exact:
        print("server block at line %d-%d  listen=%s  -> already has 'location = %s', left alone"
              % (b0 + 1, b1 + 1, ", ".join(listens), prefix))
        continue
    # 插在那一块的 ^~ location 之前，缩进跟随它；每个块各插一份，不再是"整个文件插第一处"。
    for j in range(b0, b1 + 1):
        m = main_re.match(code(lines[j]))
        if m:
            indent = m.group(1)
            block = [
                indent + "# 裸路径补斜杠：客户端路由的 basename 是 " + prefix + "，裸路径在浏览器里解析不到首页。",
                indent + "# 目标写死 https，不要用相对路径——相对 Location 按连接协议拼接，而 Cloudflare 是明文回源。",
                indent + "location = " + prefix + " {",
                indent + "    return 308 https://$host" + prefix + "/;",
                indent + "}",
                "",
            ]
            inserts.append((j, "\n".join(block)))
            print("server block at line %d-%d  listen=%s  -> INSERT 'location = %s' before line %d"
                  % (b0 + 1, b1 + 1, ", ".join(listens), prefix, j + 1))
            break
    else:
        print("server block at line %d-%d has the exact-match but no '^~ %s' line?! skipping"
              % (b0 + 1, b1 + 1, prefix))

if not bearing:
    print("no server block contains 'location ^~ %s' -- the geohot snippet is not in this file at all"
          % prefix)
    print("paste deploy/geohot/geohot.nginx.conf片段 first (README-deploy.md step 7), then run this.")
    sys.exit(2)

if not inserts:
    print("nothing to add -- every vhost that has '^~ %s' already carries 'location = %s'" % (prefix, prefix))
    if len(bearing) < 2 and allow_single != "1":
        print("NOTE: only one server block carries the %s locations at all -- see rule 3 of the snippet." % prefix)
    sys.exit(4)

# 规则 3：:80 与 :443 两个 vhost 都要有这组 location。只找到一个就大声拒绝，不再"静默只修一半"。
if len(bearing) < 2 and allow_single != "1":
    print("only ONE server block carries the %s locations (listen: %s)."
          % (prefix, ", ".join(bearing[0][2])))
    print("This package's rule 3 says both the :80 and the :443 vhost must have them, because")
    print("Cloudflare reaches the origin in plaintext on port 80. Fixing only one leaves the public")
    print("path still 404-ing on the bare prefix. Refusing to write anything.")
    sys.exit(3)

out = list(lines)
for j, blk in sorted(inserts, reverse=True):
    out[j:j] = blk.split("\n")
open(dst, "w", encoding="utf-8").write("\n".join(out))
print("wrote %s: %d vhost(s) carry the %s locations, %d exact-match redirect(s) added, %d already present"
      % (dst, len(bearing), prefix, len(inserts), len(bearing) - len(inserts)))
PY
rc=$?
set -e
cat "$WORK/report.txt"
if [[ $rc -eq 4 ]]; then
  echo
  echo "每个挂了 $PREFIX 的 server 块都已经有那条 exact-match 308 —— 无需改动，没有写文件、没有 reload。"
  exit 0
elif [[ $rc -eq 3 ]]; then
  echo
  echo "!! 只有一个 server 块挂了 $PREFIX。本包的硬约束是 :80 与 :443 **两个** vhost 都要有 geohot 那组" >&2
  echo "   location（Cloudflare 以 80 端口明文回源 —— 见 geohot.nginx.conf片段 头部第 3 条）。" >&2
  echo "   只补一处 = 从 443 直连正常、公网仍然踩裸路径 404。要么把片段补进另一个 vhost 再来，" >&2
  echo "   要么确实只有这一个监听并明白后果：GEOHOT_ALLOW_SINGLE_VHOST=1 重跑。" >&2
  exit 3
elif [[ $rc -ne 0 ]]; then
  echo "!! 生成新配置失败（退出码 $rc）—— 没有写任何文件。" >&2
  exit 1
fi

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "DRY-RUN 结束：上面是将要发生的事。确认无误后 bash fix-bare-path.sh --apply"
  exit 0
fi

# ---- 以下只在 --apply 时执行 ----
sudo cp -a "$CONF" "$BAK"
echo "backup: $BAK"
echo "before: $(sudo sha256sum "$CONF" | cut -c1-16)"

if ! sudo cp "$NEW" "$CONF"; then
  echo "!! 写入失败 —— 站点文件未变（备份仍在 $BAK）" >&2
  exit 1
fi
echo "after:  $(sudo sha256sum "$CONF" | cut -c1-16)"
sudo grep -n -A1 "location = $PREFIX" "$CONF" || true

# nginx -t 不过就回滚备份，绝不带病 reload；通过了也只用 reload。
if sudo nginx -t; then
  sudo systemctl reload nginx
  sleep 3
  echo "nginx: $(systemctl is-active nginx)（reload，不是 restart）"
  echo "验证: curl -s -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}\\n' -L https://xxc2007.me$PREFIX"
  echo "      期望 200 1 https://…$PREFIX/  —— 或直接 bash verify-deploy.sh 看第 2 节那条裸前缀断言"
else
  echo "TEST FAILED — restoring $CONF from $BAK" >&2
  sudo cp -a "$BAK" "$CONF"
  sudo nginx -t || echo "!! 回滚后 nginx -t 仍不过：这与本脚本无关，站点本来坏了。保留 $BAK，人工排查。" >&2
  exit 1
fi
