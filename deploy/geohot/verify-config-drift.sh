#!/usr/bin/env bash
# 配置漂移核对：装在这台机器上的 systemd 单元、生产 .env 的键名、单元引用的外部文件与代码入口，
# 是不是仓库里那一份能说清楚的。**只读**，且**只打印键名与路径，永不打印值**——凭据出现在输出里
# 就等于把它交给了日志、会话与终端回滚缓冲。
#
# 为什么需要它：站长要求"通过服务器或 GitHub 仓库都能随时迁移"。这两句话的差别不在代码，而在
# 配置——本轮实测就抓到过：生产 CN 桥的单元里有 WORKBUDDY_VARIANT/BRIDGE_PORT 两行、仓库那份没有
# （照仓库恢复出来的机器会用国际版变体去连中国版凭据，并和另一条抢 3065，那扇门直接死掉）。
# 这种差别不会让任何测试变红，只会在新机器上安静地少一扇门。
set -uo pipefail

APP="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
UNITS_DIR="${GEOHOT_UNITS_DIR:-/etc/systemd/system}"
ENV_FILE="${GEOHOT_ENV_FILE:-$APP/.env}"
TEMPLATE="$APP/.env.example"
UNIT_NAMES=(geohot-api.service geohot-archive.service geohot-archive.timer geohot-brain.service geohot-web.service geohot-workbuddy-cn.service geohot-workbuddy.service geohot-worker.service)
# 这些路径是**凭据与目录清单**，设计上就不进仓库；恢复时它们来自迁移备份包，不是 git clone。
SECRET_PATHS="/opt/geohot/workbuddy-credential.json /opt/geohot/workbuddy-cn-credential.json /opt/geohot/workbuddy-catalog.json /opt/geohot/workbuddy-cn-catalog.json /opt/geohot/workbuddy-cn.env /opt/geohot/.dbpass"
fails=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'DRIFT: %s\n' "$*"; fails=$((fails+1)); }

[ -d "$APP" ] || { echo "app root missing: $APP" >&2; exit 2; }
cd "$APP" || exit 2
have_git=0
git rev-parse --git-dir >/dev/null 2>&1 && have_git=1
[ "$have_git" = 1 ] || note "（这个目录不是 git 仓库——单元比对改用同名文件是否在树里存在来判断）"

echo "== 1. 安装的单元 vs 仓库里的单元（去注释、去空行后必须逐字节相等）=="
strip_file() { grep -vE '^[[:space:]]*#' "$1" | grep -vE '^[[:space:]]*$'; }
for u in "${UNIT_NAMES[@]}"; do
  repo="deploy/geohot/systemd/$u"; inst="$UNITS_DIR/$u"
  if [ ! -f "$repo" ]; then bad "$u 仓库里没有 $repo"; continue; fi
  if [ ! -f "$inst" ]; then
    note "  $u: 本机没装（新机器上由 install-units.sh 装；这里不算漂移）"
    continue
  fi
  d=$(diff <(strip_file "$repo") <(strip_file "$inst") | grep -E '^[<>]' || true)
  if [ -z "$d" ]; then echo "  $u: SAME"; else
    bad "$u 安装的与仓库的不一致："
    printf '%s\n' "$d" | sed 's/^/      /'
  fi
done

echo "== 2. .env 的键名是否都在 .env.example 里（只比名字，不比值）=="
[ -f "$TEMPLATE" ] || { bad "缺模板 $TEMPLATE"; }
if [ -f "$ENV_FILE" ] && [ -f "$TEMPLATE" ]; then
  keys_of() { grep -oE '^[A-Z][A-Z0-9_]*=' "$1" | tr -d '=' | sort -u; }
  missing=$(comm -23 <(keys_of "$ENV_FILE") <(keys_of "$TEMPLATE") | tr '\n' ' ')
  extra=$(comm -13 <(keys_of "$ENV_FILE") <(keys_of "$TEMPLATE") | tr '\n' ' ')
  note "  .env 键数=$(keys_of "$ENV_FILE" | wc -l) 模板键数=$(keys_of "$TEMPLATE" | wc -l)"
  if [ -n "${missing// /}" ]; then bad "这些生产键名在 .env.example 里没有，照模板拷的新机会静默少配置：$missing"; else echo "  生产用到的键全部有模板位"; fi
  [ -n "${extra// /}" ] && note "  （模板里多出的键，新机器留空即可：$extra）"
fi

echo "== 3. 单元引用的 EnvironmentFile：存在？在仓库里，还是登记的机器侧文件？=="
for u in "${UNIT_NAMES[@]}"; do
  [ -f "$APP/deploy/geohot/systemd/$u" ] || continue
  grep -hoE '^EnvironmentFile=.*' "$APP/deploy/geohot/systemd/$u" 2>/dev/null | sed 's/^EnvironmentFile=-\?//' | while read -r p; do
    [ -n "$p" ] || continue
    case "$p" in \!*) p="${p#!}";; esac
    if [ ! -e "$p" ]; then echo "  MISSING  $p（$u 引用它）"; continue; fi
    if case " $SECRET_PATHS " in *" $p "*) true;; *) false;; esac; then echo "  machine  $p（凭据/目录清单，随迁移备份包走，不进仓库）"
    elif [ "$p" = "/etc/geohot/archive-cycle.conf" ] && [ -f "$APP/deploy/geohot/archive-cycle.conf.example" ]; then
      # 这份不是秘密，是**阀门数字**；仓库带的是同名样例，第 5 节专门比它的键形。
      echo "  sampled  $p（仓库有 deploy/geohot/archive-cycle.conf.example）"
    elif [ -f "${p#/}" ] && { [ "$have_git" = 0 ] || git ls-files --error-unmatch "${p#/opt/geohot/app/}" >/dev/null 2>&1; }; then echo "  tracked  $p"
    else echo "  untracked $p ← 若它不含秘密，就该进仓库"; fi
  done
done | sort -u

echo "== 4. ExecStart 指向的代码入口在不在树里 =="
# 相对路径是相对于**该单元自己的 WorkingDirectory**，不是应用根：geohot-web 的 wd 是 apps/web，
# 拿应用根去解 `server.ts` 会得到一个假 MISSING（这条在演练里真踩到过）。
for u in "${UNIT_NAMES[@]}"; do
  f="$APP/deploy/geohot/systemd/$u"
  [ -f "$f" ] || continue
  wd=$(grep -m1 -E '^WorkingDirectory=' "$f" | cut -d= -f2-)
  [ -n "$wd" ] || wd="$APP"
  grep -hoE '^ExecStart=.*' "$f" \
    | sed -E 's/^ExecStart=//; s/^\/usr\/bin\/node (--env-file=[^ ]+ )?//' \
    | grep -vE '^/bin/bash' | while read -r t; do
      [ -n "$t" ] || continue
      target="${t%% *}"
      case "$target" in
        /*) [ -e "$target" ] || echo "  MISSING abs $target（$u）"; ;;
        *)  [ -e "$wd/$target" ] || echo "  MISSING $wd/$target（$u）"; ;;
      esac
    done
done | sort -u

echo "== 5. 归档阀门：/etc/geohot/archive-cycle.conf 与仓库样例是否同形 =="
if [ -f /etc/geohot/archive-cycle.conf ]; then
  live=$(grep -oE '^GEOHOT_[A-Z_]+=' /etc/geohot/archive-cycle.conf | tr -d '=' | sort -u | tr '\n' ' ')
  ex="deploy/geohot/archive-cycle.conf.example"
  if [ -f "$ex" ]; then
    sample=$(grep -oE '^GEOHOT_[A-Z_]+=' "$ex" | tr -d '=' | sort -u | tr '\n' ' ')
    if [ "$live" = "$sample" ]; then echo "  键形一致：$live"; else bad "线上阀门键与样例不一致 live=[$live] sample=[$sample]"; fi
  else bad "缺 $ex —— 新机器没有 /etc/geohot/archive-cycle.conf 就恢复不出归档周期"; fi
else note "  本机没有 /etc/geohot/archive-cycle.conf（不是生产机，跳过）"; fi

echo
if [ "$fails" -gt 0 ]; then echo "RESULT: $fails 处漂移（上面的 DRIFT 行）"; exit 1; fi
echo "RESULT: 配置无漂移——这台机器的运行配置可以只靠仓库复现（秘密项见第 3 节的 machine 行，走迁移备份包）"
