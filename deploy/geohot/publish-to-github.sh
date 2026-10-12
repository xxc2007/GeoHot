#!/usr/bin/env bash
# publish-to-github.sh — 把本地 HEAD 作为一个原子提交发布到公开仓库 main，然后当场逐字节验收。
#
# 为什么是这一条命令而不是"一条条 contents API PUT"：
#   1) 按文件 PUT 会把工作区的 CRLF 写进线上 blob（内容等价、哈希不等），"仓库与源码同步"就在字节层面是假的；
#      这里从 HEAD 取树，Git 自己保证 LF。
#   2) 按文件 PUT 会留下"一半发布"的中间态——README 引用了还没上传的图，读者看到裂开的介绍页。
#      这里是一棵树一次提交，要么全到要么全不到。
#   3) 线上历史与本地历史是两条线（线上是发布线，本地是开发线），所以不 force push、不改写历史：
#      新提交的父节点就是当前远端 HEAD，树换成发布树，快进一条。
#
# 排除清单只有一处来源：deploy/geohot/publish-excludes（与 verify-github-sync.sh 共用同一份）。
# **那份清单现在是空的**——也就是说公开仓库的内容与本地 HEAD 逐字节一致，一个文件都不缺。
# 这里以前写着"唯一的排除项是 .github/"，那是 2026-10-02 之前的状态：GitHub 拒绝没有 `workflow` 作用域的
# token 创建或更新 `.github/workflows/*`（实测 push 报 "refusing to allow an OAuth App to create or update
# workflow … without `workflow` scope"），所以 CI 定义的正本搬到了 `tooling/ci-check.yml`，`.github/` 不再是
# 被"排除"的东西——本地就没有这个目录。要跑 Actions 的人按 tooling/ci-check.yml 头部那两行复制回去。
#
# 跑之前必须满足的三件事（脚本自己会检查后两件，第一件不会）：
#   1) `gh` 已登录且令牌有 repo 作用域：`gh auth status` 能看到账号；`gh api repos/$REPO --jq .permissions.push`
#      必须返回 true。缺这一步时脚本会在读远端 HEAD 那一步（下面第 2 步）报 "✗ 读不到 <repo>@<branch>"。
#   2) 已跟踪的内容干净（下面第 1 步实测，脏就退出 1）：半改完的状态不该被发布，六个 agent 并发改这棵树时尤其。
#      未跟踪的路径只提示不拦（它们进不了发布树；站长的宣传片三件就是刻意不跟踪的）。
#   3) 本地 HEAD 就是你要发布的那一棵：先 `git log --oneline -3` 看一眼，发布是快进推送，不 force、不改历史。
#
# 用法：
#   bash deploy/geohot/publish-to-github.sh --dry-run -m "提交信息"   # 只算树、只报差异，不推
#   bash deploy/geohot/publish-to-github.sh -m "提交信息"             # 推 + 验收
# 环境变量:
#   GEOHOT_REPO / GEOHOT_BRANCH（默认 main）/ GEOHOT_EXCLUDES_FILE
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

ORIGIN_REPO=$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')
# 下面 fetch 与 push 走的都是 origin，而 REPO 可以被 GEOHOT_REPO 换成另一个仓库：那样"与远端比对"的是
# A 仓、推出去的是 B 仓，最后一行还报"发布完成"。要么不设，要么必须与 origin 是同一个仓库。
if [[ -n "${GEOHOT_REPO:-}" && "${GEOHOT_REPO%/}" != "$ORIGIN_REPO" ]]; then
  echo "✗ GEOHOT_REPO=$GEOHOT_REPO 与 origin ($ORIGIN_REPO) 不是同一个仓库，而本脚本 fetch/push 都走 origin" >&2
  exit 1
fi
REPO="${GEOHOT_REPO:-$ORIGIN_REPO}"
BRANCH="${GEOHOT_BRANCH:-main}"
EXCLUDES="${GEOHOT_EXCLUDES_FILE:-deploy/geohot/publish-excludes}"
message=""
dry=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message) message=${2:-}; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done
[[ -n "$message" ]] || { echo "必须给 -m \"提交信息\""; exit 2; }

# 1) 工作树里**已跟踪**的部分必须干净：半改完的状态不该被发布，六个 agent 并发改这棵树时尤其。
#    未跟踪的文件不进发布树（第 3 步是从 HEAD 读树），所以它们不再拦发布——以前是拦的，
#    于是站长那三件宣传片（`docs/promo/`，按 a5954b4 刻意退回版本管理、但仍在磁盘上）会把每一次发布都堵死。
#    未跟踪清单照样打出来：漏 add 一个新源文件 = 线上少一个文件而仓库说"发布成功"，这要看得到。
dirty=$(git status --porcelain --untracked-files=no)
[[ -n "$dirty" ]] && { echo "✗ 已跟踪的内容有未提交的改动，先提交或清理："; printf '%s\n' "$dirty" | head -20; exit 1; }
untracked=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked" ]]; then
  printf '%s\n' "$untracked" | sed 's/^/  未跟踪 /' | head -8
  echo "（共 $(printf '%s\n' "$untracked" | wc -l) 个未跟踪路径，它们不进发布树；其中若有应当发布的新源文件，先 git add）"
fi
head=$(git rev-parse HEAD)

# 2) 远端当前 HEAD（用 gh 读，代理环境下比 git ls-remote 稳），并且**把那个提交取回本地**：
#    commit-tree 的父节点必须是一个本地存在的对象，否则报 "not a valid object"。
#    线上是发布线、本地是开发线，所以这里要的是取回，不是合并——工作区与本地 HEAD 一概不动。
remote_head=$(gh api "repos/$REPO/git/ref/heads/$BRANCH" --jq .object.sha) || { echo "✗ 读不到 $REPO@$BRANCH"; exit 1; }
git fetch --quiet --no-tags origin "$BRANCH" || { echo "✗ 取不回 origin/$BRANCH，无法把新提交接在发布线后面"; exit 1; }
git cat-file -e "$remote_head" 2>/dev/null || remote_head=$(git rev-parse FETCH_HEAD) || { echo "✗ 取回的远端提交不在本地对象库"; exit 1; }
echo "本地 HEAD $head"
echo "远端 $BRANCH $remote_head"

# 3) 在临时索引里造发布树：先整棵 HEAD，再按排除清单摘掉不发布的路径。不碰工作区。
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
export GIT_INDEX_FILE="$work/publish.index"
git read-tree "$head"
# 排除清单只解析一次，读法与 verify-github-sync.sh 一致：不依赖文件末尾的换行，也不要在 EOF 后转空圈。
EXLIST=""
if [[ -f "$EXCLUDES" ]]; then
  while IFS= read -r line; do
    clean=${line%%#*}
    clean=${clean//[[:space:]]/}
    [[ -z "$clean" ]] && continue
    EXLIST+="$clean"$'\n'
  done < <(cat "$EXCLUDES"; echo)
fi
excluded() {
  local p=$1 c
  while IFS= read -r c; do
    [[ -z "$c" ]] && continue
    [[ "$p" == "$c" || "$p" == "$c"/* ]] && return 0
  done <<< "$EXLIST"
  return 1
}
if [[ -n "$EXLIST" ]]; then
  while IFS= read -r c; do
    [[ -z "$c" ]] && continue
    git rm -r --cached --quiet --ignore-unmatch "$c" || true
    echo "排除 $c"
  done <<< "$EXLIST"
fi

# 3.4) 把"只在发布线上长着"的路径带回来，别让一次发布悄悄把它们删掉。
#
# 为什么要单独做这一步：`commit-tree` 的父节点是**远端 HEAD**，而树是从**本地 HEAD**读出来的。
# Git 记录的不是"我改了哪些文件"，而是"父树到新树的差异"——所以凡是远端有、本地没有的路径，
# 都会被写成一条删除。2026-10-12 实测 `git diff --name-status HEAD origin/main` 正好差三个文件：
#   docs/promo/geohot-promo.mp4、docs/promo/index.html、docs/promo/poster.jpg
# 那是站长的宣传片与它的播放页，在另一台克隆里直接发到 GitHub、又按 a5954b4 从本仓库的版本管理里
# 退了回去（16 MB 的 mp4 不该进版本库）。不处理这一步，收尾那一次发布就会把介绍页三件套从公开仓删了，
# 而**验收脚本看不见**：它比的是发布之后的两边，那当然相等（#94 那次手工带的，就是这个道理）。
#
# "远端独有"和"开发线故意删掉"必须分开，否则这里会把该删的文件又救回来。用共同祖先判：
#   · 祖先里没有这个路径 ⇒ 它是发布线上自己长出来的（远端直接加的、或另一台克隆发的）⇒ 带过来；
#   · 祖先里有、HEAD 里没有 ⇒ 是开发线自己删的 ⇒ 删除照发，不救。
# 判不出祖先（两条无共同历史的历史，例如仓库重建）时按"带过来"处理——多留一个文件的代价
# 远小于把站长的东西删掉，而且差异会在第 4 步整屏打出来。
# `--no-renames` 是刻意的：默认开着的重命名检测会把"远端这一件 + 本地删掉的另一件很像它"
# 判成一次改名（状态 R），而 `--diff-filter=A` 只收 A ⇒ 该带回来的东西一条都不剩。
# 本机 `diff.renames=false`（全局配置里写着），所以今天不加也一样——但换一台没这条配置的机器
# （服务器克隆、新机器、站长自己）就会变，这类"只在写它的那台机器上成立"的判据正是最坑的那种。
base=$(git merge-base "$head" "$remote_head" 2>/dev/null || true)
carried=0; dropped=0
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  excluded "$p" && continue
  if [[ -n "$base" ]] && git cat-file -e "$base:$p" 2>/dev/null; then
    echo "删除 $p（开发线自己删掉的文件，删除照常发布）"
    dropped=$((dropped + 1))
    continue
  fi
  meta=$(git ls-tree "$remote_head" -- ":(literal)$p")
  [[ -z "$meta" ]] && { echo "✗ 读不到远端 $p 的对象，无法带过来——宁可不发，也不悄悄删它" >&2; exit 1; }
  mode=$(printf '%s' "$meta" | awk '{print $1}')
  sha=$(printf '%s' "$meta" | awk '{print $3}')
  git update-index --add --cacheinfo "$mode,$sha,$p" \
    || { echo "✗ 把 $p 带回发布树失败" >&2; exit 1; }
  echo "带过来 $p（$mode，只在发布线上存在）"
  carried=$((carried + 1))
done < <(git -c core.quotepath=off diff --no-renames --name-only --diff-filter=A "$head" "$remote_head")
[[ $carried -gt 0 ]] && echo "→ 从 $remote_head 带回 $carried 个发布线独有路径（删除 $dropped 个开发线自己删的）"
tree=$(git write-tree)
unset GIT_INDEX_FILE
# 3.5) 公开仓的底线检查。后面的逐字节验收只证明"发出去的就是这棵树"，它证明不了"这棵树里没有秘密"：
#      源站地址、SSH 用户名、密钥文件名一旦进了公开仓，删掉历史也已经被爬过。所以在 commit-tree 之前拦。
# 名字表跟 `.gitignore`  guard 的那一族对齐（`*.env*`、`*.key`、`*.p8`、`secrets*`、`credentials*`、`id_*`），
# 只放过仓库里那两个 `.env.example` / `.env.pipeline.example` 空值模板——它们是文档，不是秘密。
# `.data/` 是**目录前缀**，不能跟别的写在同一个 `$` 锚里：`(…|\.data/)$` 只匹配路径正好以 `.data/` 结尾，
# `.data/foo.db` 从它下面过（审计 2026-10-10 实测），所以它单列在锚外。
# `core.quotepath=off` 也是承重的那一半：默认配置会把非 ASCII 路径整条加引号（`"资料/秘密/.env"`），
# 结尾那个引号让每条 `$` 锚失效——`.env` 与 `*.pem` 这类形状刚好都是靠 `$` 收尾匹配的。
# 本机全局配置里写着 `core.quotepath=false` 所以看不出来，换一台机器就是另一回事。
BAD_PATHS=$(git -c core.quotepath=off ls-tree -r --name-only "$tree" | grep -E '(^|/)(\.env(\.[a-z0-9-]+)?|id_(rsa|ed25519|ecdsa|dsa|openssh)[^/]*|[^/]*\.(pem|key|p8)|secrets[^/]*|credentials[^/]*)$|(^|/)\.data/' | grep -vE '\.example$' || true)
if [[ -n "$BAD_PATHS" ]]; then
  echo "✗ 要发布的树里有 .env / 私钥 / *.pem 这类路径，公开仓不收：" >&2
  printf '%s\n' "$BAD_PATHS" | sed 's/^/    /' >&2
  exit 1
fi
# 内网/私有地址段（源站的局域网地址就属于这一类）。127.0.0.1、0.0.0.0 与文档惯用的 TEST-NET 三段放过。
# 唯一的例外是 tests/url.test.ts：它是 SSRF 防护的测试夹具，必须用**真实存在**的私有段地址
# （10/8、172.16/12、192.168/16、100.64/10、169.254/16）才能证明这些地址被挡住——换成 TEST-NET
# 就测不到那几段，测试会失去意义。这个文件里没有任何一台真实机器的地址；要加第二个例外之前，
# 先想清楚公开仓里到底该不该有那个地址。
BAD_IP=$(git grep -I -n -E '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3})[^0-9]' "$tree" -- . ':(exclude)tests/url.test.ts' 2>/dev/null | grep -v 'TEST-NET' | head -8 || true)
if [[ -n "$BAD_IP" ]]; then
  echo "✗ 要发布的树里出现内网/私有地址段字面量（前 8 行）：" >&2
  printf '%s\n' "$BAD_IP" | sed 's/^/    /' >&2
  echo "  测试里要用的话请改 127.0.0.1 或 TEST-NET（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）。" >&2
  exit 1
fi
# 只提示不拦：这些形状出现在文档里通常是正当的，但它们正是"泄露源站访问方式"的形状，要看一眼。
# 以前这一步把 deploy/geohot/ 与 docs/ 整目录排除掉了——恰恰是这些字符串最可能出现的地方，等于对
# 自己看不见；现在只放过占位符形状（`<user>@<host>`）、加粗示例、`.gitignore` 与扫描器自己的正则。
git grep -I -n -E '(ssh |scp |rsync )[a-z0-9_.-]+@|(^|[^a-z])(root|ubuntu|azure-admin)@|\.pem' "$tree" -- . 2>/dev/null \
  | grep -vE '(<[^>]*@[^>]*>|\*\*|\.gitignore:|publish-to-github\.sh)' | head -8 | sed 's/^/  注意 /' || true

commit=$(git commit-tree "$tree" -p "$remote_head" -m "$message") || { echo "✗ commit-tree 失败"; exit 1; }
echo "发布树 $tree"
echo "发布提交 $commit"

# 4) 发布前后差异先说清楚（这次到底改了什么，读者会看到什么）
echo "── 与远端当前内容的差异 ──"
git -c core.quotepath=off diff --stat "$remote_head" "$tree" | tail -30

if [[ $dry -eq 1 ]]; then
  echo "（--dry-run：没有推送）"
  exit 0
fi

# 5) 推。留一个 refs/publish/last 记录"发出去的是哪个提交"，方便回滚与复核。
git update-ref refs/publish/last "$commit"
if ! git push origin "refs/publish/last:refs/heads/$BRANCH"; then
  echo "✗ 推送失败（token 作用域？TLS 代理？）。远端未变，本地 refs/publish/last 仍指向 $commit"
  exit 1
fi
echo "✓ 已推送 $BRANCH → $commit"

# 6) 当场验收：逐字节比对 + 图片取回 + SVG 严格解析 + README 引用
if bash deploy/geohot/verify-github-sync.sh; then
  echo "✓ 发布完成并通过逐字节验收"
  exit 0
fi
echo "✗ 推送成功但验收未通过——现在公开仓库与源码不一致，按 docs/known-issues.md 的回滚流程处理"
exit 1
