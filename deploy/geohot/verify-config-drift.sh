#!/usr/bin/env bash
# 配置漂移核对：装在这台机器上的 systemd 单元、生产 .env 的键名、单元引用的外部文件与代码入口，
# 是不是仓库里那一份能说清楚的。**只读**。
#
# 为什么需要它：站长要求"通过服务器或 GitHub 仓库都能随时迁移"。这两句话的差别不在代码，而在
# 配置——本轮实测抓到过：生产 CN 桥的单元里有 WORKBUDDY_VARIANT/BRIDGE_PORT 两行、仓库那份没有
# （照仓库恢复出来的机器会用国际版变体去连中国版凭据，并和另一条抢 3065，那扇门直接死掉）。
# 这种差别不会让任何测试变红，只会在新机器上安静地少一扇门。
#
# 隐私边界（被评审逐条挑过，这里写清楚以免下一个人放松）：
#   · 第 2/3/5 节只打印**键名与路径**；
#   · 第 1 节必须打印整行才能比对，所以先过 redact：单元里若有人手工塞了 `Environment=*KEY*=…`
#     这类内联值，打出来的是 `<redacted>` 而不是值本身。
set -uo pipefail

APP="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
UNITS_DIR="${GEOHOT_UNITS_DIR:-/etc/systemd/system}"
ENV_FILE="${GEOHOT_ENV_FILE:-$APP/.env}"
TEMPLATE="$APP/.env.example"
UNIT_NAMES=(geohot-api.service geohot-archive.service geohot-archive.timer geohot-brain.service geohot-web.service geohot-workbuddy-cn.service geohot-workbuddy.service geohot-worker.service)
# 设计上就不进仓库、恢复时来自迁移备份包的机器侧文件（凭据与目录清单）。
SECRET_PATHS="/opt/geohot/workbuddy-credential.json /opt/geohot/workbuddy-cn-credential.json /opt/geohot/workbuddy-catalog.json /opt/geohot/workbuddy-cn-catalog.json /opt/geohot/workbuddy-cn.env /opt/geohot/.dbpass"
fails=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'DRIFT: %s\n' "$*"; fails=$((fails+1)); }
# 比对单元用的行脱敏：值一律换掉，只留"哪条指令"。
redact() {
  sed -E 's/^([<>][[:space:]]*(Environment(A)?|ExecStart|ExecReload)[A-Za-z]*=).*/\1 <redacted>/'
}

[ -d "$APP" ] || { echo "app root missing: $APP" >&2; exit 2; }
cd "$APP" || exit 2
have_git=0
git rev-parse --git-dir >/dev/null 2>&1 && have_git=1
[ "$have_git" = 1 ] || note '（这个目录不是 git 仓库——第 3 节改用"路径在不在应用根下"来判断）'
strip_file() { grep -vE '^[[:space:]]*#' "$1" | grep -vE '^[[:space:]]*$'; }

echo "=== 1. 安装的单元 vs 仓库里的单元（去注释、去空行后必须逐字节相等）==="
for u in "${UNIT_NAMES[@]}"; do
  repo="deploy/geohot/systemd/$u"; inst="$UNITS_DIR/$u"
  if [ ! -f "$repo" ]; then bad "$u 仓库里没有 $repo"; continue; fi
  if [ ! -f "$inst" ]; then
    note "  $u: 本机没装（新机器上由 install-units.sh 装；这里不算漂移）"
    continue
  fi
  d=$(diff <(strip_file "$repo") <(strip_file "$inst") | grep -E '^[<>]' || true)
  if [ -z "$d" ]; then echo "  $u: SAME"; else
    bad "$u 安装的与仓库的不一致（值已脱敏）："
    printf '%s\n' "$d" | redact | sed 's/^/      /'
  fi
done

echo "=== 2. .env 的键名是否都在 .env.example 里（只比名字，不比值）==="
# 键名匹配放宽到"允许缩进 + 小写"，否则一个写成 ` llm_api_key=` 的行会被静默跳过，
# 而这一节就会绿着说"全部有模板位"——那是假绿。
keys_of() { grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" | tr -d ' =' | sort -u; }
if [ ! -f "$TEMPLATE" ]; then
  bad "缺模板 $TEMPLATE"
elif [ ! -f "$ENV_FILE" ]; then
  note "  本机没有 $ENV_FILE（新机还没配环境）——这一节跳过，不算漂移"
else
  missing=$(comm -23 <(keys_of "$ENV_FILE") <(keys_of "$TEMPLATE") | tr '\n' ' ')
  extra=$(comm -13 <(keys_of "$ENV_FILE") <(keys_of "$TEMPLATE") | tr '\n' ' ')
  note "  .env 键数=$(keys_of "$ENV_FILE" | wc -l) 模板键数=$(keys_of "$TEMPLATE" | wc -l)"
  if [ -n "${missing// /}" ]; then bad "这些生产键名在 .env.example 里没有，照模板拷的新机会静默少配置：$missing"; else echo "  生产用到的键全部有模板位"; fi
  [ -n "${extra// /}" ] && note "  （模板里多出的键，新机器留空即可：$extra）"
fi

echo "=== 3. 单元引用的 EnvironmentFile：存在？在仓库里，还是登记的机器侧文件？==="
for u in "${UNIT_NAMES[@]}"; do
  f="$APP/deploy/geohot/systemd/$u"
  [ -f "$f" ] || continue
  grep -hoE '^EnvironmentFile=.*' "$f" | sed 's/^EnvironmentFile=-\?//' | while read -r p; do
    [ -n "$p" ] || continue
    case "$p" in \!*) p="${p#!}";; esac
    if [ ! -e "$p" ]; then echo "  MISSING  $p（$u 引用它）"; continue; fi
    case " $SECRET_PATHS " in
      *" $p "*) echo "  machine  $p（凭据/目录清单，随迁移备份包走，不进仓库）"; continue ;;
    esac
    case "$p" in
      "$APP/.env"|"$APP/.env."*) echo "  secret   $p（应用环境文件：里面是密钥，按设计不进仓库；键名由第 2 节核对）"; continue ;;
    esac
    if [ "$p" = "/etc/geohot/archive-cycle.conf" ] && [ -f "$APP/deploy/geohot/archive-cycle.conf.example" ]; then
      echo "  sampled  $p（仓库有 deploy/geohot/archive-cycle.conf.example，第 5 节比键形）"
    elif git ls-files --error-unmatch "${p#"$APP"/}" >/dev/null 2>&1; then
      echo "  tracked  $p"
    else
      echo "  untracked $p ← 核对过它不含秘密才留这句话；否则登记进 SECRET_PATHS"
    fi
  done
done | sort -u

echo "=== 4. ExecStart 指向的代码入口在不在树里 ==="
# 相对路径是相对**该单元自己的 WorkingDirectory**，不是应用根：geohot-web 的 wd 是 apps/web。
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

echo "=== 5. 归档阀门：/etc/geohot/archive-cycle.conf 与仓库样例是否同形 ==="
if [ -f /etc/geohot/archive-cycle.conf ]; then
  live=$(grep -oE '^[A-Z][A-Z0-9_]*=' /etc/geohot/archive-cycle.conf | tr -d '=' | sort -u | tr '\n' ' ')
  ex="deploy/geohot/archive-cycle.conf.example"
  if [ -f "$ex" ]; then
    sample=$(grep -oE '^[A-Z][A-Z0-9_]*=' "$ex" | tr -d '=' | sort -u | tr '\n' ' ')
    if [ "$live" = "$sample" ]; then echo "  键形一致：$live"; else bad "线上阀门键与样例不一致 live=[$live] sample=[$sample]"; fi
  else bad "缺 $ex —— 新机器没有 /etc/geohot/archive-cycle.conf 就恢复不出归档周期"; fi
else note "  本机没有 /etc/geohot/archive-cycle.conf（不是生产机，跳过）"; fi

echo
if [ "$fails" -gt 0 ]; then echo "RESULT: $fails 处漂移（上面的 DRIFT 行）"; exit 1; fi
echo "RESULT: 配置无漂移——这台机器的运行配置可以只靠仓库复现（机器侧秘密项见第 3 节的 machine/secret 行，走迁移备份包）"
