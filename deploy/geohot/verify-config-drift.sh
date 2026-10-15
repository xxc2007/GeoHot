#!/usr/bin/env bash
# 配置漂移核对：装在这台机器上的 systemd 单元、生产 .env 的键名、单元引用的外部文件与代码入口，
# 是不是仓库里那一份能说清楚的。**只读**，不改任何东西、不重启任何服务。
#
# 为什么需要它：站长要求"通过服务器或 GitHub 仓库都能随时迁移"。这两句话的差别不在代码，而在
# 配置——本轮实测抓到过：生产 CN 桥的单元里有 WORKBUDDY_VARIANT/BRIDGE_PORT 两行、仓库那份没有
# （照仓库恢复出来的机器会用国际版变体去连中国版凭据，并和另一条抢 3065，那扇门直接死掉）。
# 这种差别不会让任何测试变红，只会在新机器上安静地少一扇门。
#
# 退出码：0 = 无漂移；1 = 有漂移（DRIFT 行）；2 = 这台机器核对不了（缺应用根、一个单元都没装、
# 或 git 读不到 HEAD）。**"跑不动"绝不能算通过**——2026-10-15 上一版就是把这个当 0 返回。
#
# 隐私边界（被评审逐条挑过，这里写清楚以免下一个人放松）：
#   · 第 2/3/5 节只打印**键名与路径**；
#   · 第 1 节必须打印整行才能比对，所以只脱敏 `Environment=` 的**值**（单元里内联塞秘密的地方）。
#     ExecStart / ExecReload / EnvironmentFile 打的是**路径**，第 3 节本来就原样打印这些路径，
#     原样比对才不会把"换了一个 EnvironmentFile"看成一式两份的相同行（上一版就是：正则里的
#     `(Environment(A)?|...)[A-Za-z]*=` 连 `EnvironmentFile=` 一起吞掉，两条不同路径都渲染成
#     `EnvironmentFile= <redacted>`，diff 于是看不见差别）。
set -uo pipefail

APP="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
APP="${APP%/}"   # 带着尾斜杠传进来时，"$APP/.env" 会变成 "//.env"，第 3 节的分类会整体错位
UNITS_DIR="${GEOHOT_UNITS_DIR:-/etc/systemd/system}"
ENV_FILE="${GEOHOT_ENV_FILE:-$APP/.env}"
# 该核对哪些单元：以**仓库模板目录里实际有什么**为准，而不是这里再抄一份名单。
# 上一版这里硬写 8 个名字、install-units.sh 里又写一遍，两份名单各自漂移：加第 9 个模板时
# 两边都不会提醒谁，于是"本机装着、仓库恢复不出"这种情况反而被排除在核对范围之外。
UNIT_NAMES=()
# 一律用**绝对路径**列：这里在 `cd "$APP"` 之前跑，写成相对路径就会按调用者的当前目录去找，
# 从应用根之外调用时一个都列不出来 → 直接 exit 2「仓库模板目录里没有单元」——
# 那是一条假红，而且 install-units.sh --apply 会因此把装好的机器判成"跑不动核对"（2026-10-15 实测复现）。
for f in "$APP"/deploy/geohot/systemd/*.service "$APP"/deploy/geohot/systemd/*.timer; do
  [[ -e "$f" ]] && UNIT_NAMES+=("$(basename "$f")")
done
if [ "${#UNIT_NAMES[@]}" = 0 ]; then
  echo "仓库模板目录 $APP/deploy/geohot/systemd 里一个 geohot 单元都没有——没什么可核对，但不能算通过" >&2
  exit 2
fi
# 设计上就不进仓库、恢复时来自迁移备份包的机器侧文件（凭据与目录清单）。
SECRET_PATHS_DEFAULT="/opt/geohot/workbuddy-credential.json /opt/geohot/workbuddy-cn-credential.json /opt/geohot/workbuddy-catalog.json /opt/geohot/workbuddy-cn-catalog.json /opt/geohot/workbuddy-cn.env /opt/geohot/.dbpass"
# GEOHOT_SECRET_PATHS 可以整体改写这份清单。留这个口子不是为了运营调它，是为了这道闸门自己
# 能被验证：路径全写死 /opt 时，没人能在不碰生产的前提下同时证明"它会红"和"它不会冤枉人"。
SECRET_PATHS="${GEOHOT_SECRET_PATHS-$SECRET_PATHS_DEFAULT}"
fails=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'DRIFT: %s\n' "$*"; fails=$((fails+1)); }
# 只把 `Environment=` 的值换掉；指令名与路径保留。
redact() {
  sed -E 's/^([<>][[:space:]]*Environment=).*/\1 <redacted>/'
}

[ -d "$APP" ] || { echo "app root missing: $APP" >&2; exit 2; }
cd "$APP" || exit 2
have_git=0
# 用 sudo 跑（install-units.sh 就是）时，root 对 geohot 所有的仓库会被 git 的 ownership 检查挡下来，
# 报"dubious ownership"、rev-parse 非零 ⇒ have_git 悄悄变 0，然后这句会理直气壮地说"这台机器不是 git 仓库"。
git -c "safe.directory=$APP" rev-parse --git-dir >/dev/null 2>&1 && have_git=1
[ "$have_git" = 1 ] || note '（这个目录不是 git 仓库——第 1/2 节只能比机器上的工作树、第 3 节改用"路径在不在应用根下"判断；结论不是"与 GitHub 一致"）'
strip_file() { grep -vE '^[[:space:]]*#' "$1" | grep -vE '^[[:space:]]*$'; }
# 同一个过滤，走 stdin：HEAD 里那份是 `git show` 出来的文本，落不到文件名上。
# （strip_file 收的是**文件名**，把它当过滤器用会得到 `grep: : No such file`，
# 仓库那侧静默变空，于是每一个单元都报"与 HEAD 不一致"——2026-10-15 自己踩进去过，是自测抓出来的。）
strip_stdin() { grep -vE '^[[:space:]]*#' | grep -vE '^[[:space:]]*$'; }

# 仓库那份单元到底以谁为准：有 git 就必须是 HEAD 里的那一份。
# 只比机器上的 deploy/geohot/systemd/*.service 是不够的——在那儿改一行、install-units.sh 照它装进
# /etc，两边永远相等，而 GitHub 上还是旧的：这台机器"看着无漂移"却恢复不回同一台。
repo_text() { # repo_text <仓库内相对路径>；成功时把"仓库里的那一份"写到 stdout，失败返回非零
  local path="$1"
  if [ "$have_git" = 1 ]; then
    git -c "safe.directory=$APP" show "HEAD:$path" 2>/dev/null || return 1
  else
    [ -f "$path" ] && cat "$path" || return 1
  fi
}
repo_unit() { repo_text "deploy/geohot/systemd/$1"; }

echo "=== 1. 安装的单元 vs 仓库里的那一份（有 git 比 HEAD，没 git 比本机工作树；去注释去空行后逐字节相等）==="
compared=0
for u in "${UNIT_NAMES[@]}"; do
  inst="$UNITS_DIR/$u"
  if ! base=$(repo_unit "$u"); then bad "$u 仓库里没有 deploy/geohot/systemd/$u"; continue; fi
  if [ ! -f "$inst" ]; then
    note "  $u: 本机没装（新机器上由 install-units.sh 装；这里不算漂移）"
    continue
  fi
  compared=$((compared+1))
  d=$(diff <(printf '%s\n' "$base" | strip_stdin) <(strip_file "$inst") | grep -E '^[<>]' || true)
  if [ -z "$d" ]; then echo "  $u: SAME"; else
    bad "$u 安装的与仓库里那一份不一致（值已脱敏）："
    printf '%s\n' "$d" | redact | sed 's/^/      /'
  fi
done
if [ "$compared" = 0 ]; then
  echo "无法核对：$UNITS_DIR 里一个 geohot 单元都没有——这台机器没在跑这套服务，" >&2
  echo "不能把它报成“配置无漂移”（装完的机器至少要有一份单元可比）。" >&2
  exit 2
fi

# 装了、但仓库没有模板的单元：恢复出来的新机器上它会不存在，而它可能正撑着某个端口。
extra_units=$(ls "$UNITS_DIR" 2>/dev/null | grep -E '^geohot-.*\.(service|timer)$' | sort || true)
for u in $extra_units; do
  case " ${UNIT_NAMES[*]} " in *" $u "*) ;; *) bad "$UNITS_DIR/$u 装着，但 deploy/geohot/systemd/ 里没有同名模板（照仓库恢复不出这一条）"; ;; esac
done

# 1b. drop-in 与 mask：install-units.sh 自己就教操作者"补一份 drop-in"，所以这里必须看得见，
# 否则"这台机器在跑的单元能只靠仓库复现"那句话是假的——一个改了 ExecStart 的 override.conf
# 不会让第 1 节报任何差别，因为它比对的是被覆盖的那个主文件。
echo "--- 1b. drop-in 覆盖与 mask ---"
dropins_seen=0
for u in "${UNIT_NAMES[@]}"; do
  [ -d "$UNITS_DIR/$u.d" ] || continue
  for di in "$UNITS_DIR/$u.d"/*.conf; do
    [ -f "$di" ] || continue
    dropins_seen=$((dropins_seen+1))
    changed=$(grep -oE '^[[:space:]]*(Exec(Start|StartPre|StartPost|Stop|Reload)(\[\w*\])?|Environment(A)?File?|WorkingDirectory|Memory(Max|High)|CPUQuota|Restart)[[:space:]]*=' "$di" | tr -d ' ' | sort -u | tr '\n' ' ')
    if [ -n "$changed" ]; then
      bad "$di 覆盖了改变行为的指令（$changed）——照仓库恢复不出这一段，要么把它折进 deploy/geohot/systemd/$u，要么在这份文档里登记它"
    else
      note "  $di：只写了不改运行语义的指令"
    fi
  done
done
if [ -e "$UNITS_DIR" ]; then
  for u in $extra_units; do
    if [ -L "$UNITS_DIR/$u" ] && [ ! -e "$UNITS_DIR/$u" ]; then
      bad "$UNITS_DIR/$u 是断链或指向 /dev/null（多半被 systemctl mask 掉了）——它不会被任何服务起起来，但也不能说它与仓库一致"
    fi
  done
fi
[ "$dropins_seen" = 0 ] && note "  （没有 geohot-*.service.d/ 目录）"

echo "=== 2. .env 的键名是否都在 .env.example 里（只比名字，不比值）==="
# 键名匹配放宽到"允许缩进 + 小写"，否则一个写成 ` llm_api_key=` 的行会被静默跳过，
# 而这一节就会绿着说"全部有模板位"——那是假绿。
keys_of() { grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$1" | tr -d ' =' | sort -u; }
keys_stdin() { grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' | tr -d ' =' | sort -u; }
# 模板要比**仓库里那一份**，不能比机器上的 .env.example：机器上顺手补一行键名，
# 这一节就绿了，而照 GitHub 恢复的机器还是缺那一行——正是这道闸门存在的理由。
tpl_src=$([ "$have_git" = 1 ] && echo "仓库 HEAD 的 .env.example" || echo "本机工作树的 .env.example（这台机器不是 git 仓库）")
if ! tpl_text=$(repo_text ".env.example"); then
  bad "读不到仓库里那一份 .env.example（git 里没有？还是没权限？）——这一节没法核对，不算通过"
elif [ ! -r "$ENV_FILE" ] && [ -e "$ENV_FILE" ]; then
  # 上一版用 `-f`：文件在但读不到（0600 geohot，而这一版以别的 uid 跑）时 grep 静默失败，
  # 键名集合为空，comm 一减就是"生产用到的键全部有模板位"——读不到被报成没问题。
  bad "读不到 $ENV_FILE（权限？要以 root 或 geohot 跑）——这一节没法核对，不算通过"
elif [ ! -e "$ENV_FILE" ]; then
  note "  本机没有 $ENV_FILE（新机还没配环境）——生产侧键名无从取，这一节跳过，不算漂移"
else
  env_keys=$(keys_of "$ENV_FILE"); tpl_keys=$(printf '%s\n' "$tpl_text" | keys_stdin)
  n_env=$(printf '%s\n' "$env_keys" | grep -c . || true)
  note "  模板取自：$tpl_src；.env 键数=$n_env 模板键数=$(printf '%s\n' "$tpl_keys" | grep -c . || true)"
  if [ "$n_env" = 0 ]; then
    bad "$ENV_FILE 里一个键名都没读到——空的或读不动，不能算“键名都有模板位”"
  else
    missing=$(comm -23 <(printf '%s\n' "$env_keys") <(printf '%s\n' "$tpl_keys") | tr '\n' ' ')
    extra=$(comm -13 <(printf '%s\n' "$env_keys") <(printf '%s\n' "$tpl_keys") | tr '\n' ' ')
    if [ -n "${missing// /}" ]; then bad "这些生产键名在 .env.example 里没有，照模板拷的新机会静默少配置：$missing"; else echo "  生产用到的键全部有模板位"; fi
    [ -n "${extra// /}" ] && note "  （模板里多出的键，新机器留空即可：$extra）"
  fi
fi

echo "=== 3. 单元引用的 EnvironmentFile：存在？在仓库里，还是登记的机器侧文件？==="
# MISSING! 是硬失败（单元没写 `-` 前缀，systemd 没这个文件就起不来）；
# MISSING? 对应 `EnvironmentFile=-…`（可选），只登记不报红。
# 仓库模板与机器上装着的两份都扫：模板改了、/etc 里还是旧的，缺的文件可能只出现在其中一边。
sec3=$(for u in "${UNIT_NAMES[@]}"; do
  for f in "$APP/deploy/geohot/systemd/$u" "$UNITS_DIR/$u"; do
    [ -f "$f" ] || continue
    grep -E '^EnvironmentFile=' "$f" | while IFS= read -r line; do
      p=${line#EnvironmentFile=}; p=${p#-}; p=${p#!}
      [ -n "$p" ] || continue
      case "$line" in EnvironmentFile=-*) tag='?' ;; *) tag='!' ;; esac
      # 先认"设计上不进仓库的机器侧文件"，再看它在不在。
      # 顺序反过来会咬人：`workbuddy-cn.env` 是登记过的备份包资产（docs/migration.md 第 6.5 节），
      # 照 GitHub 单独恢复的第一台机器上它本来就不存在，于是 install-units.sh 装完 8 个单元、
      # 再被自己这道闸门判红退出 1——那条"随时可以从仓库迁移"的路就走不通了（2026-10-15 复现）。
      case " $SECRET_PATHS " in
        *" $p "*)
          if [ -e "$p" ]; then echo "  machine  $p（凭据/目录清单，随迁移备份包走，不进仓库）"
          else echo "  machine-absent $p（登记过的机器侧文件，本机暂时没有；恢复后从迁移包放入，不算漂移）"; fi
          continue ;;
      esac
      if [ ! -e "$p" ]; then echo "  MISSING$tag  $p（$f 引用它）"; continue; fi
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
  done
done | sort -u)
[ -n "$sec3" ] && printf '%s\n' "$sec3"

echo "=== 4. ExecStart 指向的代码入口在不在树里 ==="
# 相对路径是相对**该单元自己的 WorkingDirectory**，不是应用根：geohot-web 的 wd 是 apps/web。
sec4=$(for u in "${UNIT_NAMES[@]}"; do
  f="$APP/deploy/geohot/systemd/$u"
  [ -f "$f" ] || continue
  wd=$(grep -m1 -E '^WorkingDirectory=' "$f" | cut -d= -f2-)
  [ -n "$wd" ] || wd="$APP"
  grep -hoE '^ExecStart=.*' "$f" \
    | sed -E 's/^ExecStart=//; s/^\/usr\/bin\/node (--env-file=[^ ]+ )?//' \
    | sed -E 's#^(/usr/)?bin/(ba)?sh ##' | while read -r t; do
      [ -n "$t" ] || continue
      target="${t%% *}"
      case "$target" in
        /*) [ -e "$target" ] || echo "  MISSING abs $target（$u）"; ;;
        *)  [ -e "$wd/$target" ] || echo "  MISSING $wd/$target（$u）"; ;;
      esac
    done
done | sort -u)
[ -n "$sec4" ] && printf '%s\n' "$sec4"

echo "=== 5. 归档阀门：/etc/geohot/archive-cycle.conf 用的键，仓库样例认不认得 ==="
# 同样留一个只用于验证的口子：写死 /etc 时，"解开一行样例里就邀请解开的阀门"这种回归没法在不碰生产的前提下复现。
LIVE_CONF="${GEOHOT_ARCHIVE_CONF:-/etc/geohot/archive-cycle.conf}"
if [ -e "$LIVE_CONF" ] && [ ! -r "$LIVE_CONF" ]; then
  # 读不到就说读不到，别把它当成"没有阀门"或"键形不一致 live=[]"（第 2 节同一个坑，别再挖一次）。
  bad "读不到 $LIVE_CONF（权限？要以 root 跑）——这一节没法核对，不算通过"
elif [ -f "$LIVE_CONF" ]; then
  live=$(grep -oE '^[[:space:]]*[A-Z][A-Z0-9_]*=' "$LIVE_CONF" | tr -d ' =' | sort -u)
  ex="deploy/geohot/archive-cycle.conf.example"
  if [ -f "$ex" ]; then
    # 样例里"要动再解开"的那几行也算已登记：GEOHOT_NEWS_DOORS / MIN_ABSTRACT / PHASE_SECONDS
    # 天生就是注释状态，解开了用反而是样例邀请的做法。上一版比的是**集合全等**，
    # 于是站长一解开阀门，install-units.sh 就把装好的单元判红退出 1。
    sample=$(grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=' "$ex" | tr -d ' #=' | sort -u)
    unknown=$(comm -23 <(printf '%s\n' "$live") <(printf '%s\n' "$sample") | tr '\n' ' ')
    documented=$(comm -13 <(printf '%s\n' "$live") <(printf '%s\n' "$sample") | tr '\n' ' ')
    if [ -n "${unknown// /}" ]; then
      bad "线上阀门用了仓库样例不认得的键：$unknown —— 照样例拷的新机器会静默丢掉这一档"
    else
      echo "  线上阀门的键仓库样例都认得（$(printf '%s\n' "$live" | tr '\n' ' ')）"
    fi
    [ -n "${documented// /}" ] && note "  （样例登记着、本机没写的键，脚本会用默认值：$documented）"
  else bad "缺 $ex —— 新机器没有 /etc/geohot/archive-cycle.conf 就恢复不出归档周期"; fi
elif [ -f "$UNITS_DIR/geohot-archive.timer" ]; then
  # 上一版这里写的是"不是生产机，跳过"。可这台机器就是生产机：定时器装着、阀门文件没了，
  # archive-cycle.sh 会退回脚本默认值（MAX_ITEMS=100 PER_MONTH=30 SLICES=6），
  # 与样例的 40/500/12 差一个量级，而全绿——那是一句不成立的"没漂移"。
  bad "装了 geohot-archive.timer 却没有 $LIVE_CONF：归档周期会用脚本默认值，不是样例那组（要么装 conf，要么把定时器摘掉）"
else
  note "  本机既没有 $LIVE_CONF 也没装归档定时器（跳过，不算漂移）"
fi

# 第 3/4 节要判红的行在这里数，而不是在循环里 `bad`：那两节挂在 `| sort -u` 右边，是子 shell，
# 里面 `fails=fails+1` 加的那个 1 会随子 shell 一起消失（上一版就是这么"报了出来但永远不红"）。
if printf '%s\n' "$sec3" | grep -q '^  MISSING! '; then
  bad "有单元必需的 EnvironmentFile 不存在（上面 MISSING! 行）——单元没写 - 前缀，systemd 找不到它就起不来"
fi
if [ -n "$sec4" ]; then bad "有单元的 ExecStart 指向树里不存在的入口（上面 MISSING 行）——那条服务在这台机器上根本起不来"; fi

echo
if [ "$fails" -gt 0 ]; then echo "RESULT: $fails 处漂移（上面的 DRIFT 行）"; exit 1; fi
# 结论这句话不许超过证据：/opt/geohot/app 在 2026-10-15 实测**不是** git 仓库，那时第 1 节比的是
# 机器上那份 deploy/geohot/systemd/ 工作树，不是 GitHub 上的 HEAD。"与仓库一致"得由
# deploy/geohot/verify-github-sync.sh 逐文件比 blob 才能说，这里不能顺手替它作证。
if [ "$have_git" = 1 ]; then
  echo "RESULT: 配置无漂移——这台机器在跑的单元、.env 键名、外部文件与代码入口，都能只靠仓库 HEAD 复现（机器侧秘密项见第 3 节的 machine/secret 行，走迁移备份包；第 1 节比的就是 HEAD）"
else
  echo "RESULT: 与本机工作树无漂移——注意：$APP 不是 git 仓库，第 1 节比的是机器上 deploy/geohot/systemd/ 的那一份，不是 GitHub 的 HEAD。这一句不能证明\"与远端仓库一致\"，那一件事由 verify-github-sync.sh 逐文件比 blob 来证。"
fi
