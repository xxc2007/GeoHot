#!/usr/bin/env bash
# 一次上线的完整序列：解包 → chown → 迁移 → **带前缀重建 web** → 重启**全部六个**单元 → 验收。
#
# 为什么要有这个文件：2026-10-12 18:29 我按 DEPLOYMENT.md 手工走了一遍，漏掉两步，
# 把站点弄 down 了约 6 分钟，而且是自己弄 up 又自己弄 down 的那种——
#   ① `npm run build -w @aihot/web` 我是在 `bash -lc` 里跑的，而 **BASE_PATH 是构建期变量、
#      .env 里根本没有它**（线上单元也不注入），于是构建出的是不带 `/geohot` 前缀的包；
#      nginx 把 `/geohot` 整段转给 web(:3000)，前缀一丢就是 `/geohot/*` 全线 404。
#   ② 重启清单写了 api/worker/web，**漏了 geohot-brain**：`tooling/brain-stub.ts` 也在这轮改动里，
#      而 Node 不热更新自己的代码 ⇒ 进程在跑旧 stub（verify-deploy 的指纹比对抓到了它）。
# 这两步在文档里都有字，但"有字的手工清单"没挡住我——所以把它们写进代码里，让漏不掉。
#
# 用法（本地，仓库根）：
#   bash deploy/geohot/deploy.sh                       # 只打印将要做什么（默认 DRY-RUN）
#   bash deploy/geohot/deploy.sh --apply               # 真上线：需要 ~/.ssh 下能连到生产
#   bash deploy/geohot/deploy.sh --apply --rev=<sha>   # 上线指定提交（默认 HEAD）
# 远端一律以 root 跑（`/opt/geohot/backups` 与 `systemctl` 都要 root），凭据只在服务器 .env。
set -euo pipefail

APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
BASE_PATH="${GEOHOT_BASE_PATH:-/geohot}"          # 构建期前缀；域名根部署显式传空串
REV="${HEAD_SHA:-HEAD}"
APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --rev=*) REV="${a#--rev=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$a（可用 --apply / --rev=<sha>）" >&2; exit 2 ;;
  esac
done

# 六个常驻单元一个都不能少：api/web/worker/brain + 两条 workbuddy 桥。
# 桥漏重启的后果不是 502，而是"跑着旧代码还 200"——比崩了更难查。
UNITS=(geohot-brain geohot-api geohot-worker geohot-web geohot-workbuddy geohot-workbuddy-cn)
# 只有装了才重启：不是每台机器都跑桥（verify-deploy 也按这个口径判）。
unit_list() { printf '%s ' "${UNITS[@]}"; }

sha="$(git rev-parse "$REV")"
short="$(git rev-parse --short "$REV")"
tree="$(git rev-parse "$REV^{tree}")"
echo "rev=$short sha=${sha:0:12}… tree=${tree:0:12}…  base_path='$BASE_PATH'  apply=$APPLY"

# 工作树里已跟踪的部分必须干净：半改完的状态不该被上线（六个 agent 并发改这棵树时尤其）。
dirty="$(git status --porcelain --untracked-files=no)"
[[ -z "$dirty" ]] || { echo "✗ 已跟踪内容有未提交改动，先提交或清理："; printf '%s\n' "$dirty" | head -20; exit 1; }

pkg="/tmp/geohot-deploy-$short.tar.gz"
git archive --format=tar "$REV" | gzip > "$pkg"
echo "artifact: $pkg  members=$(tar -tzf "$pkg" | wc -l)  bytes=$(wc -c < "$pkg")"
tar -tzf "$pkg" | grep -qE '(^|/)(node_modules|\.data|\.env|\.git)/' && { echo "✗ 包里出现不该部署的路径" >&2; exit 1; }

if (( ! APPLY )); then
  echo "（DRY-RUN：包已生成，没有上传也没有解包。确认后用 --apply）"
  exit 0
fi

SSH_TARGET="${GEOHOT_SSH_TARGET:-}"
SSH_KEY="${GEOHOT_SSH_KEY:-}"
SSH_KNOWN="${GEOHOT_SSH_KNOWN_HOSTS:-}"
[[ -n "$SSH_TARGET" && -n "$SSH_KEY" ]] || {
  echo "✗ 需要 GEOHOT_SSH_TARGET=user@host 与 GEOHOT_SSH_KEY=~/.ssh/xxx.pem（不要把口令写进命令行）" >&2
  exit 2
}
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=25 -o ServerAliveInterval=30 -i "$SSH_KEY")
[[ -n "$SSH_KNOWN" ]] && ssh_opts+=(-o UserKnownHostsFile="$SSH_KNOWN" -o HostKeyAlias=xxc2007.me)

pkg_sha="$(sha256sum "$pkg" | cut -c1-16)"
scp -o BatchMode=yes -i "$SSH_KEY" ${SSH_KNOWN:+-o UserKnownHostsFile="$SSH_KNOWN"} "$pkg" "$SSH_TARGET:/tmp/"

# 远端序列。注意三处刻意的写法：
#   1) 解包**不带 --delete**：`/opt/geohot/app` 是多克隆混合部署，有些文件（如 workbuddy 桥）
#      在仓库里没有对应路径，带删除会当场杀掉承担大头判定的那道门。
#   2) `tar` 的 --owner/--group 对解包不生效，所以 chown -R 是承重的，不是例行公事。
#   3) 构建前显式把 BASE_PATH 传进去（这次事故的第 ① 条），重启覆盖六个单元（第 ② 条）。
ssh "${ssh_opts[@]}" "$SSH_TARGET" "sudo BASE_PATH='$BASE_PATH' PKG_SHA='$pkg_sha' APP_ROOT='$APP_ROOT' UNITS='$(unit_list)' bash -s" <<'REMOTE'
set -uo pipefail
cd "$APP_ROOT" || { echo "ABORT: $APP_ROOT 不存在"; exit 1; }
[ "$(sha256sum /tmp/$(ls -t /tmp | grep -m1 'geohot-deploy-.*\.tar\.gz') | cut -c1-16)" = "$PKG_SHA" ] \
  || { echo "ABORT: 上传包哈希不符"; exit 1; }
PKG="/tmp/$(ls -t /tmp | grep -m1 'geohot-deploy-.*\.tar\.gz')"

echo "== 部署前代码快照 =="
bash deploy/geohot/snapshot-code.sh 2>&1 | tail -2

echo "== 解包（不删除额外文件）=="
tar -xzf "$PKG" -C "$APP_ROOT" || { echo "ABORT: extract"; exit 1; }
chown -R geohot:geohot "$APP_ROOT"

echo "== 迁移 =="
sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && node --env-file=.env scripts/migrate.ts" 2>&1 | tail -3

echo "== 带前缀重建 web（BASE_PATH=$BASE_PATH；构建与重启是相邻两步，不能拆开去干别的）=="
sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && npm run build -w @aihot/web" 2>&1 | tail -3

echo "== 重启全部常驻单元 =="
# shellcheck disable=SC2086
systemctl restart $UNITS
sleep 8
for u in $UNITS; do printf '%s=%s ' "$u" "$(systemctl is-active "$u")"; done; echo

echo "== 启动日志（Node 弃用只在启动时出现，测试套件永远看不到）=="
journalctl -u geohot-api -u geohot-worker -u geohot-web -u geohot-brain --since "-2 min" --no-pager \
  | grep -iE "deprecat|error" | head -6 || echo "(no warnings)"

echo "== 验收 =="
bash deploy/geohot/verify-deploy.sh 2>&1 | tail -6
rm -f "$PKG"
REMOTE

echo "DEPLOY_DONE rev=$short"
