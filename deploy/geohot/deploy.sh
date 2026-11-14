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
# 本地构建 web 再传制品（`--web-prebuilt`，或 GEOHOT_WEB_PREBUILT=1）。为什么要有这条路：
# 2026-11-06 23:1x 在 891 MB 的主库上跑 `npm run build -w @aihot/web`，load 冲到 31、首页 503，
# 部署脚本 `timeout 1500` 到期退出，六个单元一个都没重启。构建是**开发期的活**，不该由生产机承担；
# 更稳的是在这台有 16 GB 的机器上构建，只把 `apps/web/build` 传过去。
PREBUILT="${GEOHOT_WEB_PREBUILT:-0}"
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --rev=*) REV="${a#--rev=}" ;;
    --web-prebuilt) PREBUILT=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$a（可用 --apply / --rev=<sha> / --web-prebuilt）" >&2; exit 2 ;;
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
trap 'rm -rf "$local_stage"' EXIT
pkg="$local_stage/bundle.tar.gz"
git archive --format=tar "$REV" | gzip > "$pkg"
echo "artifact: $pkg  members=$(tar -tzf "$pkg" | wc -l)  bytes=$(wc -c < "$pkg")"
# 用 if 而不是 `grep -q && { …; }`：set -euo pipefail 下 grep 无匹配会让整行返回 1，
# 脚本会在没有任何提示的情况下退出（2026-11-14 部署卡在这里，trace 都打不出）。
if tar -tzf "$pkg" | grep -qE '(^|/)(node_modules|\.data|\.env|\.git)/'; then
  echo "✗ 包里出现不该部署的路径" >&2
  exit 1
fi

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
# 用 if 而不是 [[ ]] && …：set -e 下左侧为假会让整行返回 1，脚本静默退出（2026-11-14 第二次踩）。
if [[ -n "$SSH_KNOWN" ]]; then
  ssh_opts+=(-o UserKnownHostsFile="$SSH_KNOWN" -o HostKeyAlias=xxc2007.me)
fi

# 只做读者面的机器（/etc/geohot/readers-only）不该在部署时把 worker 拉起来：它一起来，这台 891MB
# 的机器就把首页拖到超时（2026-11-06 实测 load 19.4、home 000）。验收那边已经认这个形态，这里
# 同步——否则每次部署都会亲手把读者面打一次，而验收还会因为"worker 不该在跑"判红。
#
# 判据必须在**服务器**上查：2026-11-06 部署实测，写成本机 `sudo -n test -f` 时，在 Windows 上
# 直接是命令找不到（127），过滤静默跳过，worker 又被拉起来一次。
if ssh "${ssh_opts[@]}" "$SSH_TARGET" 'sudo -n test -f /etc/geohot/readers-only' 2>/dev/null; then
  KEEP=(); for u in "${UNITS[@]}"; do [[ "$u" == "geohot-worker" ]] || KEEP+=("$u"); done
  UNITS=("${KEEP[@]}")
  echo "readers-only: 服务器带标记，本次不重启 geohot-worker（${#UNITS[@]} 个单元照常）"
fi


pkg_sha="$(sha256sum "$pkg" | cut -d' ' -f1)"

# 本地预构建（--web-prebuilt）：只允许对 HEAD 做，否则传上去的 build 与源码不是同一棵树。
web_pkg=""
if (( PREBUILT )); then
  head_sha="$(git rev-parse HEAD)"
  [[ "$head_sha" == "$sha" ]] || {
    echo "✗ --web-prebuilt 只能用于 HEAD（当前 HEAD=${head_sha:0:8}，要求 ${sha:0:8}）" >&2; exit 2; }
  echo "== 本地构建 web（BASE_PATH='$BASE_PATH'，构建不落在生产机上）=="
  # Git Bash 会把 `BASE_PATH=/geohot` 当路径转成 `C:/Users/…/geohot`：必须关掉 MSYS 的转换，
  # 否则装上去的 bundle basename 是 Windows 路径，全站 404（2026-11-07 00:2x 真踩过）。
  if ! MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' BASE_PATH="$BASE_PATH" npm run build -w @aihot/web > "$local_stage/web-build.log" 2>&1; then
    echo "✗ 本地 web 构建失败："; tail -12 "$local_stage/web-build.log"; exit 1
  fi
  tail -2 "$local_stage/web-build.log"
  if grep -q 'C:/Users' apps/web/build/server/index.js; then
    echo "✗ 构建产物里混进了本机路径（BASE_PATH 被 MSYS 转成了 Windows 路径）" >&2; exit 1
  fi
  web_pkg="$local_stage/web-build.tar.gz"
  tar czf "$web_pkg" -C apps/web build
  echo "web artifact: $(wc -c < "$web_pkg") bytes"
fi

upload_dir="$(ssh "${ssh_opts[@]}" "$SSH_TARGET" 'umask 077; mktemp -d /tmp/geohot-upload.XXXXXXXX')"
[[ "$upload_dir" =~ ^/tmp/geohot-upload\.[A-Za-z0-9]+$ ]] || { echo "ABORT: invalid private staging path" >&2; exit 1; }
scp -o BatchMode=yes -i "$SSH_KEY" ${SSH_KNOWN:+-o UserKnownHostsFile="$SSH_KNOWN"} "$pkg" "$SSH_TARGET:$upload_dir/bundle.tar.gz"
if [ -n "$web_pkg" ]; then
  scp -o BatchMode=yes -i "$SSH_KEY" ${SSH_KNOWN:+-o UserKnownHostsFile="$SSH_KNOWN"} "$web_pkg" "$SSH_TARGET:$upload_dir/web-build.tar.gz"
fi

# 远端序列。注意三处刻意的写法：
#   1) 解包**不带 --delete**：`/opt/geohot/app` 是多克隆混合部署，有些文件（如 workbuddy 桥）
#      在仓库里没有对应路径，带删除会当场杀掉承担大头判定的那道门。
#   2) `tar` 的 --owner/--group 对解包不生效，所以 chown -R 是承重的，不是例行公事。
#   3) 构建前显式把 BASE_PATH 传进去（这次事故的第 ① 条），重启覆盖六个单元（第 ② 条）。
ssh "${ssh_opts[@]}" "$SSH_TARGET" "sudo BASE_PATH='$BASE_PATH' PKG_SHA='$pkg_sha' REV='$short' UPLOAD_DIR='$upload_dir' APP_ROOT='$APP_ROOT' WEB_PREBUILT='$([[ -n "$web_pkg" ]] && echo 1 || echo 0)' UNITS='$(unit_list)' bash -s" <<'REMOTE'
set -uo pipefail
cd "$APP_ROOT" || { echo "ABORT: $APP_ROOT 不存在"; exit 1; }

# 部署窗口在这里就打开，而不是等到重启前一行（2026-11-05 12:07 实测）：迁移、构建、
# 重建 web 都在重启之前，那段里的 5xx 同样是"我们自己弄出来的"，可窗口起始写在重启前
# 几十秒，闸门按 [DS-60, DE+60] 算，12:07 那三条照样记成读者事故、把 worker 冻了 10 分钟。
# 起始越早越安全，代价只是窗口多算两分钟。
date +%s > /run/geohot-deploy-window

# 单元模板、drop-in、闸门脚本都按 /opt/geohot/{app,bin} 写死；`GEOHOT_APP_ROOT` 指到别处时，
# 这一轮铺下去的模板会把机器的单元指向真正在跑的那个目录之外 —— 装上去的东西和服务对不上。
# 想这么干的人得显式说 ALLOW_ALT_APP_ROOT=1（测试机/迁移期），否则这里就停。
if [ "$APP_ROOT" != "/opt/geohot/app" ] && [ "${ALLOW_ALT_APP_ROOT:-0}" != "1" ]; then
  echo "ABORT: APP_ROOT=$APP_ROOT 与单元里写死的 /opt/geohot/app 不一致（要装到别处请设 ALLOW_ALT_APP_ROOT=1）"
  exit 1
fi
umask 077
[[ "$UPLOAD_DIR" =~ ^/tmp/geohot-upload\.[A-Za-z0-9]+$ ]] || exit 1
stage="$(mktemp -d /tmp/geohot-root-stage.XXXXXXXX)" || exit 1
PKG="$stage/bundle.tar.gz"
WEB_PKG="$stage/web-build.tar.gz"
trap 'rm -rf "$stage"' EXIT
install -m 600 "$UPLOAD_DIR/bundle.tar.gz" "$PKG" || exit 1
# 预构建制品也要先搬进 stage 再清上传目录：2026-11-07 00:5x 实测，只删了 bundle.tar.gz 就
# `rmdir "$UPLOAD_DIR" || exit 1`，目录里还剩 web-build.tar.gz ⇒ rmdir 报 "Directory not empty"，
# 整次部署在上传目录这一步静默退出（站点还停在上一版，日志里只有一行 rmdir）。
if [ -f "$UPLOAD_DIR/web-build.tar.gz" ]; then
  install -m 600 "$UPLOAD_DIR/web-build.tar.gz" "$WEB_PKG" || exit 1
  rm -f "$UPLOAD_DIR/web-build.tar.gz"
fi
rm -f "$UPLOAD_DIR/bundle.tar.gz"
rmdir "$UPLOAD_DIR" || exit 1
[ "$(sha256sum "$PKG" | cut -d' ' -f1)" = "$PKG_SHA" ] \
  || { echo "ABORT: 上传包哈希不符"; exit 1; }


# 这台机器只有 891MB 内存，夜里归档周期一开就把盘刷满（2026-11-06 16:47 现场：sda %util 92、
# await 21ms、18 个 D 状态进程）。那种状态下 `node scripts/migrate.ts` 连 127.0.0.1:5432 都会
# CONNECT_TIMEOUT、`react-router build` 会跑十分钟没结果 —— 迁移与构建本身都是好的，
# 只是被换页和刷盘挤死了。等压力回落再动手，比事后手工补跑便宜得多；等不到就照常继续，
# 让原来的失败处理照旧生效（宁可这一轮红，也不要把"机器很慢"写成"代码坏了"）。
wait_for_quiet() {
  local label=$1 budget=${2:-240} waited=0 step=10 io_full=0 load1=0
  while [ "$waited" -lt "$budget" ]; do
    io_full=$(awk '/^full /{split($2,a,"=");print a[2];exit}' /proc/pressure/io 2>/dev/null || echo 0)
    load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
    if [ "${io_full%%.*}" -lt "${GEOHOT_DEPLOY_IO_FULL:-60}" ] && [ "${load1%%.*}" -lt "${GEOHOT_DEPLOY_LOAD:-8}" ]; then
      [ "$waited" -gt 0 ] && echo "$label: 等了 ${waited} 秒，压力已回落（io.full=${io_full} load=${load1}）"
      return 0
    fi
    [ "$waited" -eq 0 ] && echo "$label: 机器正被 I/O 打满（io.full=${io_full} load=${load1}），先等它缓过来"
    sleep "$step"
    waited=$(( waited + step ))
  done
  echo "$label: 等了 ${budget} 秒压力仍高（io.full=${io_full} load=${load1}），照常继续"
  return 0
}

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
SNAPSHOT=$(bash deploy/geohot/snapshot-code.sh 2>&1 | tee /tmp/deploy-snapshot.log | grep -oE '/[^ ]+.tar.gz' | tail -1)
[ -n "$SNAPSHOT" ] && [ -f "$SNAPSHOT" ] || { echo "ABORT: 快照失败（回滚点没生成，不能继续）"; tail -3 /tmp/deploy-snapshot.log; exit 1; }
echo "snapshot: $SNAPSHOT"
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

# 单元模板与 drop-in 同 bin 一样只住在仓库里：install-units.sh 会铺它们，但那条是「装机路线」，
# 日常部署走不到 ⇒ 仓库里把 worker 的内存线改成 90M/150M/128M，机器上那份仍是 120M/200M，
# 每次部署重启都退回旧值（2026-11-05 实测 verify-config-drift 的唯一 DRIFT 就是这一段）。
# 只覆盖同名文件、不删机器上多出来的，也不动 enable 状态。
if [ -d "$APP_ROOT/deploy/geohot/systemd" ]; then
  installed=0
  while IFS= read -r -d '' f; do
    rel="${f#"$APP_ROOT"/deploy/geohot/systemd/}"
    install -D -m 644 "$f" "/etc/systemd/system/$rel"
    installed=$((installed + 1))
  done < <(find "$APP_ROOT/deploy/geohot/systemd" -type f \( -name '*.service' -o -name '*.timer' -o -name '*.conf' \) -print0)
  systemctl daemon-reload
  echo "systemd: 已同步 $installed 个单元模板与 drop-in 到 /etc/systemd/system"
fi

# nginx 片段同理：强制下发的 CSP 与 HSTS 全在 /etc/nginx/snippets/geohot-public-cache.conf 里，
# 而仓库只有 Report-Only 的那份副本 ⇒ 2026-11-06 之前「补 font-src」这类改动永远到不了线上。
# 只覆盖同名文件；改完 nginx -t 不过就还原、绝不让部署把站点 reload 成 500。
if [ -d "$APP_ROOT/deploy/geohot/nginx" ]; then
  nginxsync=0
  changed=0
  mkdir -p /root/nginx-snippet-backup
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    dest="/etc/nginx/snippets/$base"
    # 只同步「这台机器真的会读」的片段：snippets 里没有同名文件、也没有任何 include 指向它，
    # 装进去只会留下一份没人读的副本（2026-11-06 实测 28-geohot-public-admission.conf 被复制错位），
    # 真正的 conf.d 片段由 install-units/人工步骤负责。
    if [ ! -f "$dest" ] && ! grep -rqs "snippets/$base" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
      echo "nginx: 跳过 $base（这台机器没有 include 它）"
      continue
    fi
    if ! cmp -s "$f" "$dest"; then
      [ -f "$dest" ] && cp -a "$dest" "/root/nginx-snippet-backup/$base.$(date +%s)"
      install -m 644 "$f" "$dest"
      changed=1
    fi
    nginxsync=$((nginxsync + 1))
  done < <(find "$APP_ROOT/deploy/geohot/nginx" -type f -name '*.conf' -print0)
  if [ "$changed" = 1 ]; then
    if nginx -t >/tmp/nginx-t.log 2>&1; then
      systemctl reload nginx
      echo "nginx: 已同步 $nginxsync 个片段并 reload"
    else
      while IFS= read -r -d '' f; do
        base="$(basename "$f")"
        latest="$(ls -1t /root/nginx-snippet-backup/"$base".* 2>/dev/null | head -1)"
        [ -n "$latest" ] && install -m 644 "$latest" "/etc/nginx/snippets/$base"
      done < <(find "$APP_ROOT/deploy/geohot/nginx" -type f -name '*.conf' -print0)
      echo "nginx: 片段没通过 nginx -t（见 /tmp/nginx-t.log），已还原旧版、没有 reload"
    fi
  else
    echo "nginx: $nginxsync 个片段与仓库一致，未改动"
  fi
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
wait_for_quiet "迁移前" "${GEOHOT_DEPLOY_WAIT_SEC:-240}"
migrate_once() { sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && node --env-file=.env scripts/migrate.ts" > /tmp/deploy-migrate.log 2>&1; }
if ! migrate_once; then
  # 「连不上库」与「迁移本身报错」是两件事：前者等一轮再试，后者立刻中止。
  if grep -qE "CONNECT_TIMEOUT|ECONNREFUSED|ETIMEDOUT" /tmp/deploy-migrate.log; then
    echo "迁移: 连不上库（瞬时 I/O 饥饿），等一轮再试一次"
    wait_for_quiet "迁移重试前" 180
    migrate_once || true
  fi
  if grep -qE "CONNECT_TIMEOUT|ECONNREFUSED|ETIMEDOUT" /tmp/deploy-migrate.log; then
    echo "ABORT: 迁移失败 —— 不重启，线上继续跑旧代码（半迁移状态下重启更难查）"; tail -5 /tmp/deploy-migrate.log; exit 1
  fi
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
if [[ "${WEB_PREBUILT:-0}" == "1" ]]; then
  # 制品在部署机上构建好了（891 MB 的生产机跑不动 vite build：2026-11-06 实测 load 31、首页 503）。
  # 解包时**不清空** `apps/web` 其它内容，只覆盖 `build/`。
  echo "web: 用本地预构建的制品（跳过本机构建）"
  if ! sudo -n tar xzf "$WEB_PKG" -C "$APP_ROOT/apps/web"; then
    echo "ABORT: 预构建制品解包失败"; exit 1
  fi
  sudo -n chown -R geohot:geohot "$APP_ROOT/apps/web/build"
  echo "web: 制品已落盘（$(sudo -n du -sh "$APP_ROOT/apps/web/build" | cut -f1)）"
else
wait_for_quiet "构建前" "${GEOHOT_DEPLOY_WAIT_SEC:-240}"
if ! sudo -u geohot env BASE_PATH="$BASE_PATH" bash -lc "cd $APP_ROOT && npm run build -w @aihot/web" > /tmp/deploy-build.log 2>&1; then
  echo "ABORT: web 构建失败 —— 不重启：重启进一个坏 bundle 就是 2026-10-12 那次 6 分钟整站 404"; tail -8 /tmp/deploy-build.log
  sudo -n test -d "$ASSETS_DIR.prev" && sudo -n mv "$ASSETS_DIR.prev" "$ASSETS_DIR" || true
  # 只把 assets 挪回来是不够的：盘上已经是「新代码 + 旧 build」，下次谁一重启就带进一个和源码对不上的树。
  # 用上线前那份快照整树还原（.env 不在包里，不受影响）。
  if [ -n "$SNAPSHOT" ] && [ -f "$SNAPSHOT" ]; then
    echo "rollback: 用 $SNAPSHOT 整树还原源码（构建失败不该把新代码留在盘上）"
    sudo -n tar -xzf "$SNAPSHOT" -C "$(dirname "$APP_ROOT")" && sudo -n chown -R geohot:geohot "$APP_ROOT" && echo "rollback: 源码已回到上线前"
  else
    echo "rollback: 没找到快照包，源码仍是本次上传的版本（手工还原见 DEPLOYMENT.md）"
  fi
  exit 1
fi
tail -3 /tmp/deploy-build.log
fi
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
# 本次部署刚铺下来的 drop-in / 单元文件要先被 systemd 看见，否则 restart 用的还是旧配置，
# 而且之后每条 systemctl 都会带一句 "unit file changed on disk, run daemon-reload"（2026-11-04 现场）。
systemctl daemon-reload
# shellcheck disable=SC2086
# 换血窗口：闸门靠这个文件把"我们自己重启时打出来的 502/503"排除掉，不然每次部署都会
# 触发 r115 TRIP，把 worker 冻 30 分钟（实测 03:5x）。
# **必须写到服务器上**：deploy.sh 跑在操作者机器上（Windows Git Bash 没有 /run），以前这里
# `date +%s > /run/…` 写的是本机，服务器那份从来没出现过——2026-11-05 06:42 复核：文件空，
# 闸门照样 FENCED 10 分钟。
# 窗口的起始已经在本块开头写过了（覆盖迁移/构建/重建那两三分钟）；这里只补一次，
# 防止开头那次因为权限或 /run 满掉而没落盘——有值就不动，别把起始时间往后推。
[ -s /run/geohot-deploy-window ] || date +%s > /run/geohot-deploy-window
systemctl restart "${RUN[@]}"
sleep 8
for u in "${RUN[@]}"; do printf '%s=%s ' "${u%.service}" "$(systemctl is-active "$u")"; done; echo

# 预热：重启后的前几次 SSR 要 1.8–2.6 秒（2026-11-07 实测 1.86 / 2.64 秒），而验收紧接着就去取页面，
# 那些秒数会算到读者头上、也会把验收拖进超时。这里先把几个主要出口走一遍，让缓存和模块热起来；
# 预热失败不算部署失败（站点仍可能在服务，验收会自己判）。
if command -v curl >/dev/null 2>&1; then
  echo "== 预热读者面（不给第一个读者留下冷启动的几秒）=="
  # 串行 + 每页取两次：第一次把 SSR 与缓存建起来，第二次证明它真的热了。
  # 不能四个连发——2026-11-07 实测那样会把读者侧的名额闸门挤满，/all 与 /topics 当场 503。
  # 读者面的重活先自己扛一遍：timeline 在冷缓存下能跑到 8 秒，落到第一个读者头上
  # 就是一次 503（2026-11-07 实测 PublicReadBusyError ms=8655）。这里直接打接口，
  # 让 PostgreSQL 的缓存和应用的分钟桶缓存先热起来。
  for api in "/api/site/timeline?limit=20" "/api/site/pool?channel=all"; do
    read -r code secs <<<"$(curl -s -o /dev/null -m 30 -w '%{http_code} %{time_total}' \
      "http://127.0.0.1:${API_PORT:-3001}${api}" || echo "000 0")"
    echo "  api ${api%%\?*} ${code}/${secs}s"
    sleep 1
  done
  for path in "/" "/all" "/daily" "/topics"; do
    line="$path"
    for round in 1 2; do
      read -r code secs <<<"$(curl -s -o /dev/null -m 25 -w '%{http_code} %{time_total}' \
        "http://127.0.0.1:${WEB_PORT:-3000}${BASE_PATH:-}${path}" || echo "000 0")"
      line="$line ${code}/${secs}s"
      [ "$code" = "200" ] && [ "$round" = "1" ] && sleep 1
    done
    echo "  $line"
    sleep 1
  done
  # 页面层的缓存要等第一轮返回之后才开始算，间隔 1 秒的第二下仍在冷路径上
  # （2026-11-07 实测 /all 两次都是 1.55 秒，20 秒后才是 0.25 秒）。
  # 所以再等一轮，用第三下证明页面真的热了，而不是证明它会返回。
  sleep "${GEOHOT_WARMUP_SETTLE_SEC:-20}"
  line="(settled)"
  for path in "/" "/all"; do
    read -r code secs <<<"$(curl -s -o /dev/null -m 25 -w '%{http_code} %{time_total}' \
      "http://127.0.0.1:${WEB_PORT:-3000}${BASE_PATH:-}${path}" || echo "000 0")"
    line="$line ${path}=${code}/${secs}s"
  done
  echo "$line"
fi

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
  # 被代理的 JSON 也要通：只看 /api/health 与首页时，web→api 的代理可能还没接上，
  # 紧接着的 smoke 就会拿到 HTML 错误页（`SyntaxError: Unexpected token '<'`）。
  j=$(curl -s --max-time 3 http://127.0.0.1:3000/geohot/api/site/meta 2>/dev/null | head -c 1)
  if [ "$a" = "200" ] && [ "$w" = "200" ] && [ "$j" = "{" ]; then
    s2a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/api/health || echo 000)
    s2w=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/geohot/ || echo 000)
    s2j=$(curl -s --max-time 3 http://127.0.0.1:3000/geohot/api/site/meta 2>/dev/null | head -c 1)
    if [ "$s2a" = "200" ] && [ "$s2w" = "200" ] && [ "$s2j" = "{" ]; then ready=1; echo "api/web/JSON 代理连续两次就绪（第 $i 次探测）"; break; fi
  fi
  sleep 2
done
(( ready )) || echo "警告：90 秒内没等到 api/web/JSON 代理连续两次就绪，验收里的 smoke 可能因此假红"

date +%s >> /run/geohot-deploy-window
echo "== 验收 =="
# 失败项要看得见。以前这里是 `verify-deploy.sh 2>&1 | tail -6`，而 smoke 的 ✗ 行在输出中段，
# tail 只剩最后 RESULT 那一块 —— 于是"FAIL（2 项）"报了个计数，具体哪两条要人再手工跑一遍。
# 这里不能直接 `VERIFY_RC=$(bash … )`：命令替换把退出码留着了，但日志就只活在那一个变量里。
bash deploy/geohot/verify-deploy.sh > /tmp/deploy-verify.log 2>&1
VERIFY_RC=$?
grep -E '^(  ✗|✗)' /tmp/deploy-verify.log | head -20
tail -5 /tmp/deploy-verify.log
if [ "$VERIFY_RC" != "0" ]; then
  # 验没通过时，机器上写着「这次部署的 rev」的指纹会骗人：health 报新提交、跑的可能是旧的。
  # 把它还原成上线前那份，并把回滚命令打出来（别再让人去翻 DEPLOYMENT.md 里那一条）。
  if [ -f "$APP_ROOT/.env.bak-release" ]; then
    cp -a "$APP_ROOT/.env.bak-release" "$APP_ROOT/.env" && chown geohot:geohot "$APP_ROOT/.env"
    echo "release: 验收没过，.env 的 AIHOT_RELEASE 已还原（指纹不再自称本次提交）"
  fi
  [ -n "$SNAPSHOT" ] && echo "rollback: sudo tar -xzf $SNAPSHOT -C $(dirname "$APP_ROOT") && sudo chown -R geohot:geohot $APP_ROOT && sudo systemctl restart $(echo $UNITS)"
fi
rm -f "$PKG"
exit "$VERIFY_RC"
REMOTE

echo "DEPLOY_DONE rev=$short"
