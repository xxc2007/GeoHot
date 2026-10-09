#!/usr/bin/env bash
# verify-github-sync.sh — 逐字节核对「本地 HEAD」与「公开仓库 main」是否同一个内容。任何不符 ⇒ 非零退出。
#
# 为什么要有这个脚本：发布过去不是一条命令而是一条条 API 调用（见 docs/known-issues.md 第 4 条），
# 于是真出过三件事——README 引用的图压根不在仓库里、CRLF 混进线上 blob（内容等价但哈希不等）、
# PNG 在上传路上被吃掉字节对（8 张配图全废）。这三种失败都不会让「我觉得已经同步了」这句话自己露馅，
# 只有把两边每个 blob 的哈希摆在一起、再把图片从远端取回来验签名，才会。
#
# 只读：不动 GitHub、不动工作区、不重启任何服务。
#
# 跑之前要满足的（它自己不会替你检查第一件）：
#   1) `gh` 已登录、令牌有 repo 作用域（读远端树要它）：`gh auth status` 能出账号。
#      没登录时报的是 "✗ 读不到 <repo>@<ref>"，不是"不同步"——别把它当成内容差异去改仓库。
#   2) 本地 HEAD 就是你要比对的那一棵（默认比 HEAD 与 origin 的 main）。刚 publish 完直接跑它，
#      这才是"发布成功"的定义：不是"命令返回 0"，而是两边每个 blob 哈希相等。
#   3) 排除清单与发布脚本共用同一份 deploy/geohot/publish-excludes（现在是空的 ⇒ 要求逐字节全等）。
#
# 环境变量:
#   GEOHOT_REPO=<owner/name>     默认从 origin 的 URL 里解析
#   GEOHOT_SYNC_REF=<分支>       默认 main
#   GEOHOT_EXCLUDES_FILE=<路径>  默认 deploy/geohot/publish-excludes（发布时刻意不带的路径）
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

REPO="${GEOHOT_REPO:-$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')}"
REF="${GEOHOT_SYNC_REF:-main}"
EXCLUDES="${GEOHOT_EXCLUDES_FILE:-deploy/geohot/publish-excludes}"
WORK=$(mktemp -d)
# Node 与 Git Bash 对 `/tmp` 的解释不是同一个目录（bash 走 MSYS 的映射，node 把它当当前盘符下的 \tmp），
# 所以交给 node 的路径必须换成 Windows 形式；换不了（非 Git Bash）就原样用。
WORK_WIN=$(cygpath -w "$WORK" 2>/dev/null || printf '%s' "$WORK")
trap 'rm -rf "$WORK"' EXIT

fails=0
note() { printf '%s\n' "$*"; }
bad()  { printf '✗ %s\n' "$*"; fails=$((fails + 1)); }
# 这台机器的出站代理会偶发 `TLS handshake timeout`（实测出现过）。网络抖动不是"仓库不同步"，
# 所以每个远端读都重试；三次都失败就直接停——拿着一份空清单去比，会报出上千条假红。
# 错误文件走 mktemp：写死 /tmp/geohot-verify-gherr 时，两个人同时验收会互相盖掉对方的错误，
# 而 /tmp 里一个可预测的文件名意味着别人可以先放一个符号链接在这儿。
gherr=$(mktemp) || { echo "✗ 建不了临时文件"; exit 1; }
trap 'rm -rf "$WORK"; rm -f "$gherr"' EXIT
gh_read() {
  local attempt out
  for attempt in 1 2 3; do
    if out=$(gh api "$@" 2>"$gherr"); then printf '%s' "$out"; return 0; fi
    note "  （第 $attempt 次读 GitHub 失败：$(head -c 120 "$gherr")）"
    sleep $((attempt * 3))
  done
  return 1
}

# 排除清单：每行一个路径前缀，# 之后与空行忽略。
# 循环写法是修过的：`read || [[ -n $line ]]` 处理无结尾换行的文件时，EOF 之后 `line` 不会被清空，
# 于是这个循环在 EOF 后无限自转（实测把整个验收脚本卡死 900 秒）。补一个换行喂进去，读干净就退出。
excluded() {
  local p=$1 clean
  [[ -f "$EXCLUDES" ]] || return 1
  while IFS= read -r line; do
    clean=${line%%#*}
    clean=${clean//[[:space:]]/}
    [[ -z "$clean" ]] && continue
    [[ "$p" == "$clean" || "$p" == "$clean"/* ]] && return 0
  done < <(cat "$EXCLUDES"; echo)
  return 1
}

# ── 1. 本地 HEAD 的 blob 清单
# core.quotepath=off：本站有中文文件名（deploy/geohot/geohot.nginx.conf片段），默认输出会把它们转义。
git -c core.quotepath=off ls-tree -r HEAD | awk -F'\t' '{split($1,a," "); print $2"\t"a[3]}' > "$WORK/local.raw"
: > "$WORK/local.tsv"
# 读的顺序必须和 awk 打印的顺序一致（path 在前、sha 在后）。上一版读成 `sha path`，于是 local.tsv 的两列
# 反了：所有路径都"不在本地"、所有 sha 都"不在远端"，一次报了 1105 条假差异。
while IFS=$'\t' read -r path sha; do
  excluded "$path" || printf '%s\t%s\n' "$path" "$sha" >> "$WORK/local.tsv"
done < "$WORK/local.raw"
LC_ALL=C sort -o "$WORK/local.tsv" "$WORK/local.tsv"

# ── 2. 远端树：一次 API 调用；truncated 时必须停下来，否则「全部一致」这个结论是假的
tree_json=$(gh_read "repos/$REPO/git/trees/$REF?recursive=1") || { bad "三次都读不到 $REPO@$REF 的树（gh 未登录 / 仓库改名 / 网络抖动）——这次核对没有做，不记作同步"; exit 1; }
truncated=$(printf '%s' "$tree_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);console.log(j.truncated?"true":"false")})')
[[ "$truncated" == "true" ]] && bad "GitHub 把递归树截断了（条目过多），这次核对覆盖不全，不能记作同步"
printf '%s' "$tree_json" | node -e '
  let s = ""; process.stdin.on("data", (d) => s += d);
  process.stdin.on("end", () => { for (const t of JSON.parse(s).tree) if (t.type === "blob") console.log(t.path + "\t" + t.sha); });
' | LC_ALL=C sort > "$WORK/remote.tsv"

# 两张清单都必须非空才可比。上一次就是拿着一份空清单比，报出 1105 条"不同步"——
# 那种红比绿更危险，因为它看起来像精确的诊断。
[[ -s "$WORK/local.tsv" ]] || { bad "本地发布清单是空的（$EXCLUDES 是不是把整棵树都排除了？）——不比对"; exit 1; }
[[ -s "$WORK/remote.tsv" ]] || { bad "远端清单是空的（树读到了但没有 blob？或 $REF 是个空提交？）——不比对"; exit 1; }
local_n=$(wc -l < "$WORK/local.tsv"); remote_n=$(wc -l < "$WORK/remote.tsv")
cut -f1 "$WORK/local.tsv"  | LC_ALL=C sort > "$WORK/local.paths"
cut -f1 "$WORK/remote.tsv" | LC_ALL=C sort > "$WORK/remote.paths"
missing=$(comm -23 "$WORK/local.paths" "$WORK/remote.paths")
extra=$(comm -13 "$WORK/local.paths" "$WORK/remote.paths")
differs=$(join -t$'\t' -j1 "$WORK/local.tsv" "$WORK/remote.tsv" | awk -F'\t' '$2!=$3{print $1}')

note "比对 $REPO@$REF：本地 ${local_n} 个 blob / 远端 ${remote_n} 个（排除清单来自 $EXCLUDES）"
[[ -n "$missing" ]] && while IFS= read -r p; do [[ -n "$p" ]] && bad "远端缺文件：$p"; done <<< "$missing"
[[ -n "$extra"   ]] && while IFS= read -r p; do [[ -n "$p" ]] && bad "远端多文件（本地已删但它还在）：$p"; done <<< "$extra"
[[ -n "$differs" ]] && while IFS= read -r p; do [[ -n "$p" ]] && bad "内容不同：$p"; done <<< "$differs"

# ── 3. 图片要真能从 GitHub 取回来、而且还是那张图。
# 哈希相等只证明「存的是这些字节」，不证明「取回来的还是这些字节」——上传路上被改写过一次。
# 取的是**远端那个 sha 的 blob**（不是本地的），所以一个"远端落后"的文件不会在这里变成"图片损坏"。
note "→ 把每张图从远端取回并验签名（每张一次 API 调用）…"
join -t$'\t' -j1 "$WORK/local.tsv" "$WORK/remote.tsv" > "$WORK/join.tsv"   # path \t local \t remote
: > "$WORK/img.list"; : > "$WORK/img.names"
n=0
while IFS=$'\t' read -r path lsha rsha; do
  case "$path" in
    *.png|*.jpg|*.jpeg|*.webp|*.gif)
      n=$((n + 1))
      printf '  · %s\n' "$path" >&2
      gh api "repos/$REPO/git/blobs/$rsha" --jq .content 2>/dev/null | tr -d '\n' | base64 -d > "$WORK/dl.bin" 2>/dev/null || : > "$WORK/dl.bin"
      got=$(git hash-object "$WORK/dl.bin")
      if [[ "$got" != "$rsha" ]]; then
        bad "从 GitHub 取回的字节与远端 blob 哈希不等：$path（取回 $(wc -c < "$WORK/dl.bin") B，期望 $rsha）"
        continue
      fi
      if [[ "$lsha" != "$rsha" ]]; then
        printf '  · %s：远端与本地内容不同（已在上面记为"内容不同"），这里只验远端那份是不是合法图片\n' "$path" >&2
      fi
      cp "$WORK/dl.bin" "$WORK/img.$n"
      printf '%s\n' "$WORK_WIN/img.$n" >> "$WORK/img.list"
      printf '%s\n' "$path" >> "$WORK/img.names" ;;
  esac
done < "$WORK/join.tsv"
if [[ -s "$WORK/img.list" ]]; then
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const files = readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
    const names = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean);
    let bad = 0;
    for (const [i, f] of files.entries()) {
      const b = readFileSync(f), name = names[i];
      const sig = b.subarray(0, 8).toString("hex");
      const isPng = sig === "89504e470d0a1a0a";
      const isJpg = sig.startsWith("ffd8ff");
      if (!isPng && !isJpg) { console.log(`✗ 图片签名不合法：${name}（前 8 字节 ${sig}）`); bad++; continue; }
      if (isPng && !b.subarray(-12).includes(Buffer.from("IEND"))) { console.log(`✗ PNG 缺 IEND，文件被截断：${name}`); bad++; continue; }
      console.log(isPng ? `✓ ${name} ${b.readUInt32BE(16)}×${b.readUInt32BE(20)} ${(b.length / 1024).toFixed(0)} KiB`
                         : `✓ ${name} ${(b.length / 1024).toFixed(0)} KiB`);
    }
    process.exit(bad ? 1 : 0);
  ' "$WORK/img.list" "$WORK/img.names" || fails=$((fails + 1))
fi

# ── 4. SVG 必须过严格 XML 解析器（GitHub 渲染 README 里的 SVG 时严格，浏览器宽容）。
# 真实事故：注释里写了 `--accent`，XML 注释不允许连续两个连字符，站内一直正常、GitHub 判 Invalid image source。
svg_bad=$(git -c core.quotepath=off ls-files '*.svg' | while IFS= read -r p; do
  git show "HEAD:$p" 2>/dev/null | node --input-type=module -e '
    let s = ""; process.stdin.on("data", (d) => s += d); process.stdin.on("end", () => {
      const re = /<!--([\s\S]*?)-->/g; let m;
      while ((m = re.exec(s))) if (m[1].includes("--")) console.log("XML 注释里有 --");
      if (/<svg[\s\S]/i.test(s) && !/xmlns=/.test(s)) console.log("根元素缺 xmlns");
    });' | sed "s#^#$p: #"
done)
[[ -n "$svg_bad" ]] && while IFS= read -r line; do [[ -n "$line" ]] && bad "SVG 严格解析会失败 → $line"; done <<< "$svg_bad"

# ── 5. README 引用的相对路径必须真的在仓库里（第三种渲染失败：图在本地、路径写错、远端没有）
# 两个首页都要查：中文那份与 README.en.md 是同一套配图与相对链接，英文页裂了同样是"发布成功"在说谎。
for readme_file in README.md README.en.md; do
readme_refs=$(git show "HEAD:$readme_file" | node --input-type=module -e '
  let s = ""; process.stdin.on("data", (d) => s += d);
  process.stdin.on("end", () => {
    for (const m of s.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const u = m[1];
      if (/^(https?:|#|mailto:|data:)/.test(u)) continue;
      console.log(u.split("#")[0].split("?")[0]);
    }
  });')
[[ -n "$readme_refs" ]] && while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  excluded "$p" && continue
  git cat-file -e "HEAD:$p" 2>/dev/null || bad "$readme_file 引用了仓库里没有的路径：$p"
done <<< "$readme_refs"
done

if [[ $fails -eq 0 ]]; then
  note "✓ 本地 HEAD（去掉 $EXCLUDES 声明的路径）与 $REPO@$REF 逐字节一致：${local_n} 个 blob 全等、图片可从远端取回且签名完好、SVG 可严格解析、README 引用全部命中"
  exit 0
fi
note "✗ 同步检查失败 $fails 项"
exit 1
