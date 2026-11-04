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
BASE_PATH="${GEOHOT_BASE_PATH-/geohot}"          # 构建期前缀；域名根部署显式传空串。这里必须是 `-` 不是 `:-`：
#                                                 用 `:-` 时 `GEOHOT_BASE_PATH=""` 会被吃回 /geohot，
#                                                 那句"显式传空串"就成了假话，而假话的形状正是 2026-10-12 那次整站 404。
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

local_stage="$(mktemp -d "${TMPDIR:-/tmp}/geohot-deploy.XXXXXXXX")"
trap 'rm -f "$local_stage/bundle.tar.gz"; rmdir "$local_stage"' EXIT
pkg="$local_stage/bundle.tar.gz"
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

pkg_sha="$(sha256sum "$pkg" | cut -d' ' -f1)"
upload_dir="$(ssh "${ssh_opts[@]}" "$SSH_TARGET" 'umask 077; mktemp -d /tmp/geohot-upload.XXXXXXXX')"
[[ "$upload_dir" =~ ^/tmp/geohot-upload\.[A-Za-z0-9]+$ ]] || { echo "ABORT: invalid private staging path" >&2; exit 1; }
scp -o BatchMode=yes -i "$SSH_KEY" ${SSH_KNOWN:+-o UserKnownHostsFile="$SSH_KNOWN"} "$pkg" "$SSH_TARGET:$upload_dir/bundle.tar.gz"

# 远端序列。注意三处刻意的写法：
#   1) 解包**不带 --delete**：`/opt/geohot/app` 是多克隆混合部署，有些文件（如 workbuddy 桥）
#      在仓库里没有对应路径，带删除会当场杀掉承担大头判定的那道门。
#   2) `tar` 的 --owner/--group 对解包不生效，所以 chown -R 是承重的，不是例行公事。
#   3) 构建前显式把 BASE_PATH 传进去（这次事故的第 ① 条），重启覆盖六个单元（第 ② 条）。
ssh "${ssh_opts[@]}" "$SSH_TARGET" "sudo BASE_PATH='$BASE_PATH' PKG_SHA='$pkg_sha' REV='$short' UPLOAD_DIR='$upload_dir' APP_ROOT='$APP_ROOT' UNITS='$(unit_list)' bash -s" <<'REMOTE'
set -uo pipefail
cd "$APP_ROOT" || { echo "ABORT: $APP_ROOT 不存在"; exit 1; }
umask 077
[[ "$UPLOAD_DIR" =~ ^/tmp/geohot-upload\.[A-Za-z0-9]+$ ]] || exit 1
stage="$(mktemp -d /tmp/geohot-root-stage.XXXXXXXX)" || exit 1
PKG="$stage/bundle.tar.gz"
trap 'rm -f "$PKG"; rmdir "$stage"' EXIT
install -m 600 "$UPLOAD_DIR/bundle.tar.gz" "$PKG" || exit 1
rm -f "$UPLOAD_DIR/bundle.tar.gz"
rmdir "$UPLOAD_DIR" || exit 1
[ "$(sha256sum "$PKG" | cut -d' ' -f1)" = "$PKG_SHA" ] \
  || { echo "ABORT: 上传包哈希不符"; exit 1; }

echo "== 部署前：停定时器 + 拿住归档周期的锁 =="
# DEPLOYMENT.md 要求解包前停 timer 并拿锁：archive-cycle.sh 是 bash 边读边执行的脚本，
# 正在跑的那一轮会在解包之后读到换掉的自己。这里不假设它一定开着：记下原状态，最后按原状态还原。
TIMER_WAS_ACTIVE=0
systemctl is-active --quiet geohot-archive.timer && TIMER_WAS_ACTIVE=1
systemctl stop geohot-archive.timer 2>/dev/null || true
LOCK="$APP_ROOT/.data/archive-cycle/cycle.lock"
# 锁文件必须由 geohot 拥有：以 root 新建会让周期那边 `exec 8>` 直接 Permission denied，
# 报错长得像"锁被占用"，其实根本没打开（2026-10-12 踩过）。
[[ -e "$LOCK" ]] || install -d -o geohot -g geohot "$(dirname "$LOCK")"
exec 8>"$LOCK"
flock -w 900 8 || { echo "ABORT: 900 秒内拿不到 archive-cycle 锁（有一轮周期还在跑）—— 线上未改动"; exit 1; }

echo "== 部署前代码快照 =="
bash deploy/geohot/snapshot-code.sh > /tmp/deploy-snapshot.log 2>&1 || { echo "ABORT: 快照失败（回滚点没生成，不能继续）"; tail -3 /tmp/deploy-snapshot.log; exit 1; }
tail -2 /tmp/deploy-snapshot.log

echo "== 解包（不删除额外文件）=="
# 基线是**这台机器**的状态，不是仓库的内容：包里的 `baseline-main.txt` 是某次 `--save-baseline` 的旧值，
# 解包会把它盖掉，于是刚钉过基线的验收立刻又红（2026-11-04 踩过：钉完 20 分钟再部署，三份哈希又"变了"）。
# 所以解包前把机器上那份收起来、解包后放回去；`--save-baseline` 仍然是唯一改写它的路径。
BASELINE="$APP_ROOT/deploy/geohot/baseline-main.txt"
KEEP_BASELINE=""
if [ -f "$BASELINE" ]; then
  KEEP_BASELINE=$(mktemp)
  cp -a "$BASELINE" "$KEEP_BASELINE"
fi
tar -xzf "$PKG" -C "$APP_ROOT" || { echo "ABORT: extract"; exit 1; }
if [ -n "$KEEP_BASELINE" ]; then
  cp -a "$KEEP_BASELINE" "$BASELINE" && rm -f "$KEEP_BASELINE"
  echo "baseline: 保留机器上那份（包里的是旧值，已被放回原样）"
fi
chown -R geohot:geohot "$APP_ROOT"

# 闸门脚本住在 /opt/geohot/bin，而 tar 只铺 $APP_ROOT ⇒ 仓库里改了脚本，机器上那份不动。
# 2026-11-04 现场：PR #136 已合并且部署，`/opt/geohot/bin/r115-reader-gate.sh` 里仍没有
# `R115_ACTION`，闸门继续按 stop 模式停 worker —— 正是 PR #108 记过的同一条坑（那次是
# install-units.sh 补了拷贝，但 deploy.sh 这条日常路径没补）。这里补上，让"部署"一次就够。
if [ -d "$APP_ROOT/deploy/geohot/bin" ]; then
  install -d -m 755 /opt/geohot/bin
  install -m 755 "$APP_ROOT"/deploy/geohot/bin/*.sh /opt/geohot/bin/
  echo "bin: 已同步 $(ls -1 "$APP_ROOT"/deploy/geohot/bin/*.sh | wc -l) 个闸门/判定脚本到 /opt/geohot/bin"
fi

# 版本指纹：api 的 /api/health 读 AIHOT_RELEASE，环境变量是**机器级**的静态值，
# 部署不更新它 ⇒ 线上一直自称旧提交（2026-11-04 实测 health 报 4bf1f89，实际跑 70d2ac3）。
# 这里把本次部署的 rev 落成文件，api 侧 fallback 读它；环境变量仍优先，方便临时覆盖。
printf '%s
' "$REV" > "$APP_ROOT/.release" && chown geohot:geohot "$APP_ROOT/.release"
# 光落文件不够：api 读 `AIHOT_RELEASE` 是**环境变量优先**，而机器上的 .env 里就写死了旧值，
# 于是文件永远被盖掉（2026-11-04 实测：.release 写了，health 仍报 4bf1f89）。这里把 .env 的
# 那一行改成本次 rev，并留一份 .env.bak-release 供回滚。
if [ -f "$APP_ROOT/.env" ]; then
  cp -a "$APP_ROOT/.env" "$APP_ROOT/.env.bak-release"
  if grep -q '^AIHOT_RELEASE=' "$APP_ROOT/.env"; then
    sed -i "s|^AIHOT_RELEASE=.*|AIHOT_RELEASE=$REV|" "$APP_ROOT/.env"
  else
    printf 'AIHOT_RELEASE=%s
' "$REV" >> "$APP_ROOT/.env"
  fi
  chown geohot:geohot "$APP_ROOT/.env" "$APP_ROOT/.env.bak-release"
fi
echo "release: $APP_ROOT/.release = $REV（.env 里的 AIHOT_RELEASE 同步为本次 rev）"

# 迁移与构建的失败必须中止，不能"记个日志继续重启"：那正是"200 但站是错的"那一类，
# 而 `... | tail -3` 在 pipefail 下虽然能带出退出码，没有 set -e 也没人看它。
echo "== 迁移 =="
if ! sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && node --env-file=.env scripts/migrate.ts" > /tmp/deploy-migrate.log 2>&1; then
  echo "ABORT: 迁移失败 —— 不重启，线上继续跑旧代码（半迁移状态下重启更难查）"; tail -5 /tmp/deploy-migrate.log; exit 1
fi
tail -3 /tmp/deploy-migrate.log

echo "== 带前缀重建 web（BASE_PATH=$BASE_PATH；构建与重启是相邻两步，不能拆开去干别的）=="
# 2026-11-04 17:14 实测：`react-router build` 会清掉 `build/client/assets`，于是每次部署都让
# **已经打开的页面**请求到 404 —— 启动日志里那条 `No route matches URL
# "/geohot/assets/MobileHome-tJoU-3W8.js"` 就是读者手里那张旧 HTML 去要旧哈希资源。
# 读者不该为我们的部署刷新一次页面才能继续用：把上一版的 assets 先挪开，构建后再并回去
# （名字带哈希，同名即同内容，不会互相覆盖），只留最近两版，多的按 mtime 删掉。
ASSETS_DIR="$APP_ROOT/apps/web/build/client/assets"
sudo -n test -d "$ASSETS_DIR" && sudo -n mv "$ASSETS_DIR" "$ASSETS_DIR.prev" || true
if ! sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && npm run build -w @aihot/web" > /tmp/deploy-build.log 2>&1; then
  echo "ABORT: web 构建失败 —— 不重启：重启进一个坏 bundle 就是 2026-10-12 那次 6 分钟整站 404"; tail -8 /tmp/deploy-build.log
  sudo -n test -d "$ASSETS_DIR.prev" && sudo -n mv "$ASSETS_DIR.prev" "$ASSETS_DIR" || true
  exit 1
fi
tail -3 /tmp/deploy-build.log
if sudo -n test -d "$ASSETS_DIR.prev"; then
  sudo -n cp -an "$ASSETS_DIR.prev/." "$ASSETS_DIR/" || true   # -n：新构建的同名文件优先
  sudo -n rm -rf "$ASSETS_DIR.prev.old" || true
  sudo -n mv "$ASSETS_DIR.prev" "$ASSETS_DIR.prev.old" || true
  sudo -n rm -rf "$ASSETS_DIR.prev.old" || true
  echo "assets: 旧版哈希资源已并入（打开着的旧页面不会 404）"
fi

echo "== 重启常驻单元（只重启本机装了的）=="
# 上面那句"只有装了才重启"以前只是注释：这里真按 list-unit-files 过一遍，
# 没装桥的机器就不会在事故中途被一串 "Failed to restart …: Unit not loaded" 糊脸。
RUN=()
for u in $UNITS; do [[ -n "$(systemctl list-unit-files "$u.service" --no-legend)" ]] && RUN+=("$u.service"); done
# shellcheck disable=SC2086
systemctl restart "${RUN[@]}"
sleep 8
for u in "${RUN[@]}"; do printf '%s=%s ' "${u%.service}" "$(systemctl is-active "$u")"; done; echo

echo "== 启动日志（Node 弃用只在启动时出现，测试套件永远看不到）=="
journalctl -u geohot-api -u geohot-worker -u geohot-web -u geohot-brain --since "-2 min" --no-pager \
  | grep -iE "deprecat|error" | head -6 || echo "(no warnings)"

echo "== 验收前：把定时器放回它原来的岗位 =="
# 顺序是承重的。verify-deploy.sh 第 2 节按「装了 timer 就要求它 enabled+active」判，而这一轮上线为了
# 不让周期脚本读到半换掉的树才停掉它 —— 2026-10-13 08:59 那次就是被这条判据红了一次（RESULT: FAIL，
# 而线上其实是好的）：停 timer 是我的新代码做的，判 timer 不在岗也是我的新代码做的，验收夹在中间。
# 先还原再验收不会让档案周期在验收中途开跑：锁还在下面这个 fd 8 手里，周期那边打不开锁就等/退，
# 下一个 15 分钟档期才真正干活。本来没开的机器不会因为一次上线被打开。
# 判据是「它该在岗」而不是「进来时在岗」：机器上曾经有一次恢复没落地，timer 停在 inactive，
# 之后每次上线都读到 TIMER_WAS_ACTIVE=0 ⇒ 自己把自己钉死（2026-11-04 15:49 实测，
# 验收连红两次都是这条）。enabled 的 timer 就该在岗，进来时不在岗更该拉起来。
if (( TIMER_WAS_ACTIVE )) || systemctl is-enabled --quiet geohot-archive.timer 2>/dev/null; then
  systemctl start geohot-archive.timer
  echo "geohot-archive.timer 已恢复：$(systemctl is-active geohot-archive.timer)（进来时 was_active=$TIMER_WAS_ACTIVE）"
fi

# 验收前等一次「连续两次都 200」：单元刚拉起来的那几秒，nginx 会把 API/SSR 的请求交给还没
# 就绪的 upstream，于是 smoke 拿到的是 HTML 错误页而不是 JSON（`SyntaxError: Unexpected token '<'`）。
# 这条假红 2026-10-12 起反复出现，每次都要人隔一分钟手工重跑 —— 与其解释，不如在这里等。
echo "== 等单元回到能服务读者的状态 =="
ready=0
for i in $(seq 1 30); do
  a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/api/health || echo 000)
  w=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/geohot/ || echo 000)
  if [ "$a" = "200" ] && [ "$w" = "200" ]; then
    s2a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/api/health || echo 000)
    s2w=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/geohot/ || echo 000)
    if [ "$s2a" = "200" ] && [ "$s2w" = "200" ]; then ready=1; echo "api/web 连续两次 200（第 $i 次探测）"; break; fi
  fi
  sleep 2
done
(( ready )) || echo "警告：90 秒内没等到 api/web 连续两次 200，验收里的 smoke 可能因此假红"

echo "== 验收 =="
# 失败项要看得见。以前这里是 `verify-deploy.sh 2>&1 | tail -6`，而 smoke 的 ✗ 行在输出中段，
# tail 只剩最后 RESULT 那一块 —— 于是"FAIL（2 项）"报了个计数，具体哪两条要人再手工跑一遍。
# 这里不能直接 `VERIFY_RC=$(bash … )`：命令替换把退出码留着了，但日志就只活在那一个变量里。
bash deploy/geohot/verify-deploy.sh > /tmp/deploy-verify.log 2>&1
VERIFY_RC=$?
grep -E '^(  ✗|✗)' /tmp/deploy-verify.log | head -20
tail -5 /tmp/deploy-verify.log
rm -f "$PKG"
exit "$VERIFY_RC"
REMOTE

echo "DEPLOY_DONE rev=$short"

# 2026-11-04：闸门脚本跟着部署走，别再靠手工 scp（见 PR #137）。
