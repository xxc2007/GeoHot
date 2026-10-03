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
#   2) 工作区干净（下面第 1 步实测，脏就退出 1）：半改完的状态不该被发布，六个 agent 并发改这棵树时尤其。
#   3) 本地 HEAD 就是你要发布的那一棵：先 `git log --oneline -3` 看一眼，发布是快进推送，不 force、不改历史。
#
# 用法：
#   bash deploy/geohot/publish-to-github.sh --dry-run -m "提交信息"   # 只算树、只报差异，不推
#   bash deploy/geohot/publish-to-github.sh -m "提交信息"             # 推 + 验收
# 环境变量:
#   GEOHOT_REPO / GEOHOT_BRANCH（默认 main）/ GEOHOT_EXCLUDES_FILE
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

REPO="${GEOHOT_REPO:-$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')}"
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

# 1) 工作区必须干净：半改完的状态不该被发布，而且别人正在并发改这个仓库时发布尤其危险。
dirty=$(git status --porcelain)
[[ -n "$dirty" ]] && { echo "✗ 工作区不干净，先提交或清理："; printf '%s\n' "$dirty" | head -20; exit 1; }
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
if [[ -f "$EXCLUDES" ]]; then
  # 读法与 verify-github-sync.sh 一致：不依赖文件末尾的换行，也不要在 EOF 后转空圈。
  while IFS= read -r line; do
    clean=${line%%#*}
    clean=${clean//[[:space:]]/}
    [[ -z "$clean" ]] && continue
    git rm -r --cached --quiet --ignore-unmatch "$clean" || true
    echo "排除 $clean"
  done < <(cat "$EXCLUDES"; echo)
fi
tree=$(git write-tree)
unset GIT_INDEX_FILE
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
