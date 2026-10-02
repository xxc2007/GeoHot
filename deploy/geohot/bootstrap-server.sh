#!/usr/bin/env bash
# bootstrap-server.sh — GEOHOT 服务器一次性初始化（幂等，默认 DRY-RUN）
# 用法:
#   bash bootstrap-server.sh                # DRY-RUN：只打印将发生什么
#   bash bootstrap-server.sh --apply        # 真正执行
#   bash bootstrap-server.sh --apply --i-know-what-im-doing   # 以 root 身份执行（不推荐；脚本会 sudo -u 降权）
# 可用的环境变量（都有默认值，一次性装完就不用再传）:
#   GEOHOT_APP_ROOT=/opt/geohot/app      代码与 .env 所在的目录（整个部署包共用这一个值）
#   GEOHOT_BASE_PATH=/geohot             站点前缀；根路径部署要显式写成 GEOHOT_BASE_PATH=""
#   GEOHOT_REPO_URL=…                    clone 来源，默认就是下面那个公开仓库本体（不是占位串）
#   GEOHOT_PG_PASSWORD=…                 CREATE ROLE 用的口令；不传就本次随机生成并写进 .env。
#                                        只允许 [A-Za-z0-9._+-]（含 ' 会让 CREATE ROLE 坏掉、含 : 或 %
#                                        会让 DATABASE_URL 与 passfile 重新解释它），不合规当场拒。
#   GEOHOT_TRUST_PROXY=true|false        写进 .env 的 TRUST_PROXY。不给就实测"这台机器前面有没有反代"
#                                        （nginx.service 在不在跑）再决定 —— 见第 5 节，那里也写了猜错的代价
#   GEOHOT_MODEL_CALLS=true|false        写进 .env 的 MODEL_CALLS_ENABLED（默认 true，见第 5 节注释）
#   GEOHOT_BUILD_MEMORY_MAX=900M         第 9 节构建的 cgroup 内存上限（DEPLOYMENT.md「实际执行的四步」第 2 步）
#   GEOHOT_ALLOW_UNCAPPED_BUILD=1        本机没有 systemd-run 时，明确授权裸跑构建（不推荐）
#   GEOHOT_I_REVIEWED_ENV=1              跳过第 5 节的回车确认（值本身仍然逐项断言，非交互环境用这个）
# 每一步都有守卫：重复运行不会覆盖已有 .env、不会重建已存在的库、不会二次 clone。
# 口令一律只经管道/stdin 或 0600 的 passfile 传递，不出现在 argv（同机用户 ps 看不到）、不回显。
#
# ★ 顺序里的一条硬规矩（2026-10-02 修正）：.env 的复核（第 5 节）发生在任何数据库操作（第 6~8 节）之前。
#   以前 --apply 是先 migrate/seed、再让人去核对 .env，而那一刻 .env 里还是模板给的
#   postgres://geohot:geohot@127.0.0.1:5433/geohot（那是开发机 embedded-postgres 的串，服务器上不存在），
#   角色口令也还是占位串 CHANGE_ME_bootstrap —— 一次性bootstrap 根本走不完。现在 DATABASE_URL 由脚本按
#   它自己在第 6~7 节使用的 PG_* 值写回 .env，两边不可能再对不上，对不上了第 7 节的连接实测会拒绝继续。
set -euo pipefail

# ----------------------------------------------------------------------------
# 配置（按服务器实况改）
# ----------------------------------------------------------------------------
APP_USER="geohot"
APP_GROUP="geohot"
# 整个部署包只有一个安装路径：GEOHOT_APP_ROOT，默认 /opt/geohot/app（线上实际用的那个，见
# DEPLOYMENT.md「实际执行的四步」第 1 步）。bootstrap / install-units / verify-deploy / rollback 四个脚本
# 都读它；systemd/ 里那批 *.service 是**文本模板**（systemd 没有变量插值可用），它写死的是同一个默认值，
# 换值时不能用模板 —— 第 10 节会当场拦住，那种情况下改用 install-units.sh 按变量渲染。
# 以前这里写 /opt/geohot/GEOHOT、install-units.sh 写 /opt/geohot/app，两边还各自把对方指认为 bug ——
# 那种分叉就是这次要消灭的东西。
APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
APP_ROOT="${APP_ROOT%/}"                    # 尾斜杠会污染下面那个 %/* 推导出的 APP_HOME
APP_HOME="${APP_ROOT%/*}"                   # /opt/geohot —— geohot 账户的 HOME=（它没有登录 shell）与备份目录
[[ -n "$APP_HOME" && "$APP_HOME" != "/" ]] || { echo "!! GEOHOT_APP_ROOT='$APP_ROOT' 推不出一个安全的父目录当 HOME（APP_HOME='${APP_HOME:-空}'）—— 用 /opt/geohot/app 这种两段以上的路径" >&2; exit 2; }
ENV_PATH="$APP_ROOT/.env"
# 公开仓库本体 —— 这就是开发机上 `git remote -v` 看到的 origin，所以在干净机器上是**能用的默认值**，
# 不是占位串。以前这一行末尾写着"占位远端，公开仓库建好后替换"，而仓库早就建好了：结果是 --apply
# 在第 2 节的 clone 上死掉，整个脚本从来没跑到过第 3 节。要装 fork 或离线搬运就用 GEOHOT_REPO_URL 覆盖；
# 第 2 节真的 clone 之前会 ls-remote 一次，连不上就停下来给离线方案（不会让你看 git 的凭据提示）。
REPO_URL="${GEOHOT_REPO_URL:-https://github.com/xxc2007/GeoHot.git}"
BRANCH="${GEOHOT_BRANCH:-main}"
# 站点挂在哪个前缀上。它是**构建期**变量而不是运行期的：apps/web/vite.config.ts:12-17 与
# apps/web/react-router.config.ts:7-12 把它烧进 bundle，运行时的 BASE_PATH 对 web 进程什么都不做
# （apps/web/server.ts:46-49 的前缀取自构建产物）。nginx 的 location 前缀、SITE_URL 的路径和这里
# 必须三个一致；第 5 节会实测 SITE_URL 与它是否吻合。
# 用 `-` 而不是 `:-`：GEOHOT_BASE_PATH="" 是合法取值，含义是"这个站占域名根"（这时构建不带 BASE_PATH）。
GEOHOT_BASE_PATH="${GEOHOT_BASE_PATH-/geohot}"
GEOHOT_BASE_PATH="${GEOHOT_BASE_PATH%/}"   # 归一化成没有尾斜杠：/geohot（根路径部署时仍是空串）
PG_DATABASE="geohot"
PG_ROLE="geohot"
PG_HOST="127.0.0.1"
PG_PORT="5432"                 # 系统 PostgreSQL 的端口；★ 预检会实测，本机开发那套是 5433 embedded，不要混
PG_MIN_MAJOR=16                # 支持 16 或 17：docs/deploy.md「不用 Docker」一节的第一段；线上这台是 PGDG apt 源的 17
PG_MAX_MAJOR=17
WEB_PORT_CHECK="3000"
API_PORT_CHECK="3001"
NODE_MIN="24.11"               # package.json engines ">=24.11"（实测文件：GEOHOT/package.json:24）
SYSTEMD_SRC="$(cd "$(dirname "$0")" && pwd)/systemd"
UNITS=(geohot-brain geohot-api geohot-worker geohot-web)   # 四个常驻单元，与 DEPLOYMENT.md:10 一致

APPLY=0
I_KNOW=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --i-know-what-im-doing) I_KNOW=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# root 守卫：拒绝裸 root，除非显式确认
if [[ "$(id -u)" == "0" && "$I_KNOW" != "1" ]]; then
  echo "拒绝以 root 直接运行。请用部署用户 + sudo，或加 --i-know-what-im-doing。" >&2
  exit 1
fi

SUDO=""
if [[ "$(id -u)" != "0" ]]; then SUDO="sudo"; fi
# 降权前缀写成数组：以前 root 模式（--i-know-what-im-doing）下 SUDO 为空，"$SUDO -u geohot …" 展开成
# "-u geohot …"，把 -u 当成了命令名 —— 那条路径在第 2 节就会死。root 用 runuser，非 root 用 sudo -u。
if [[ "$(id -u)" == "0" ]]; then
  DROP_APP=(runuser -u "$APP_USER" --)
  DROP_PG=(runuser -u postgres --)
else
  DROP_APP=(sudo -u "$APP_USER")
  DROP_PG=(sudo -u postgres)
fi
# 以 $APP_USER 身份跑 node/npm/git 时必须连 HOME 一起给：sudo 与 runuser 都**保留调用者的 HOME**，
# 而 geohot 没有登录 shell，于是 npm 会把缓存写进 /home/<操作者>/.npm —— 构建时 geohot 读不到自己
# 刚写的东西，以 EACCES 收场。DEPLOYMENT.md「实际执行的四步」第 2 步那条 env HOME=/opt/geohot 就是
# 为这个；systemd 单元里也有同名的 Environment=HOME=（install-units.sh 与 systemd/*.service）。
# 凡是以 $APP_USER 身份跑构建/安装的地方都走 AS_APP，别再各处手写一遍。
AS_APP=( "${DROP_APP[@]}" env "HOME=$APP_HOME" )
# 连接实测要往 $APP_HOME 落一份 0600 的临时 passfile（口令不进 argv）；任何退出路径上都清掉。
PGPASS_FILE=""
cleanup_pgpass() { [[ -n "$PGPASS_FILE" ]] && "${DROP_APP[@]}" rm -f "$PGPASS_FILE" 2>/dev/null; return 0; }
trap cleanup_pgpass EXIT
run() { # run <描述> <命令...>
  local desc="$1"; shift
  if [[ "$APPLY" == "1" ]]; then
    echo "[APPLY] $desc"
    "$@"
  else
    echo "[DRY ] $desc"
    echo "       \$ $*"
  fi
}
run_secret() { # run_secret <描述> <隐去机密的等价命令> <命令...> —— run() 会把 "$*" 打回显，口令不能走它
  local desc="$1" shown="$2"; shift 2
  if [[ "$APPLY" == "1" ]]; then
    echo "[APPLY] $desc"
    "$@"
  else
    echo "[DRY ] $desc"
    echo "       \$ $shown"
  fi
}
step() { echo; echo "==== $* ===="; }

mask() { # mask <值> —— 连接串里的口令不进终端、不进 journalctl。口令自己可能含 @，所以主机段取"最后一个 @ 之后"
  local v="$1"
  if [[ "$v" =~ ^([a-zA-Z][a-zA-Z0-9+.-]*://[^/:]+):(.*)@([^/@]+/.*)$ ]]; then printf '%s:***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
  else printf '%s' "$v"; fi
}
env_get() { # env_get <KEY> —— .env 里最后一次出现的值；文件或键不存在返回空串。只读。
  [[ -f "$ENV_PATH" ]] || return 0
  "${DROP_APP[@]}" node -e '
const { readFileSync } = require("node:fs");
const text = readFileSync(process.argv[1], "utf8");
const key = process.argv[2];
const lines = text.match(new RegExp("^[ \\t]*" + key + "[ \\t]*=.*$", "gm"));
process.stdout.write(lines ? lines[lines.length - 1].replace(/^[^=]*=/, "") : "");
' "$ENV_PATH" "$1" 2>/dev/null || true
}
env_set() { # env_set <KEY> <value> —— 就地改写 .env 的一行。就地是因为 .env 里是密钥：/tmp 的副本别人也读得到，
  # 而追加一行会把旧值留在上面（两条都生效时取哪条不该靠运气）。注释掉的键顺手取消注释，同 init-env.ts 的 setLine()。
  "${DROP_APP[@]}" node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const [file, key, value] = process.argv.slice(1);
const text = readFileSync(file, "utf8");
const line = key + "=" + value;
const re = (src) => new RegExp(src, "m");
let out;
if (re("^[ \\t]*" + key + "[ \\t]*=").test(text)) out = text.replace(re("^[ \\t]*" + key + "[ \\t]*=.*$"), () => line);
else if (re("^#[ \\t]?" + key + "[ \\t]*=").test(text)) out = text.replace(re("^#[ \\t]?" + key + "[ \\t]*=.*$"), () => line);
else out = text.trimEnd() + "\n" + line + "\n";
writeFileSync(file, out);
' "$ENV_PATH" "$1" "$2"
}
pg_probe() { # pg_probe <SQL> —— 走集群超级用户的本机套接字读一个值；只读，读不到就返回空串
  command -v psql >/dev/null 2>&1 || return 0
  "${DROP_PG[@]}" psql -tAc "$1" 2>/dev/null || true
}
pg_admin_works() { [[ -n "$(pg_probe 'SELECT 1')" ]]; }

# ----------------------------------------------------------------------------
# 0. 预检（只读，永远执行，打印事实而不是假设）
# ----------------------------------------------------------------------------
step "0. PREFLIGHT（只读探测）"

echo "--- 本次部署的两个坐标 ---"
echo "安装目录: $APP_ROOT  （GEOHOT_APP_ROOT，四个脚本与 systemd 模板共用这一个值）"
echo "站点前缀: ${GEOHOT_BASE_PATH:-（空 = 域名根，不挂子路径）}  （GEOHOT_BASE_PATH，构建期写进 bundle）"
if [[ -z "$GEOHOT_BASE_PATH" ]]; then
  echo "  域名根部署：nginx 不需要 /geohot 那组 location，也不要有那条补斜杠的 308。"
else
  echo "  构建命令会带 BASE_PATH=$GEOHOT_BASE_PATH；nginx 片段的 location 前缀与 SITE_URL 的路径都得是同一个。"
fi

echo "--- clone 来源（第 2 节用；已 clone 过就不再需要它）---"
# 占位串一律在这里当场炸掉，不要让 --apply 跑到第 2 节去看 git 的凭据提示。
case "$REPO_URL" in
  ""|*CHANGE_ME*|*"<"*|*">"*|*"替换"*|*example.com*|*"REPO_URL"*|*"占位"*)
    echo "!! GEOHOT_REPO_URL 还是个占位串（'$REPO_URL'）—— 公开仓库是 https://github.com/xxc2007/GeoHot.git，" >&2
    echo "   要么不设这个变量用默认值，要么 GEOHOT_REPO_URL=<真的 git url> 再跑。" >&2
    exit 2 ;;
esac
echo "远端: $REPO_URL  分支: $BRANCH"
if [[ -d "$APP_ROOT/.git" ]]; then
  echo "  $APP_ROOT 已是 git 仓库 —— 第 2 节只 fetch，不重新 clone"
else
  echo "  远端可达性要到第 2 节才实测（只有真要 clone 时才需要网络与权限）；"
  echo "  离线搬运的装法见 DEPLOYMENT.md「实际执行的四步」第 1 步（git archive + tar --owner=geohot）。"
fi

echo "--- 身份 ---"
echo "当前用户: $(id -un) (uid=$(id -u))  主机: $(hostname)"

echo "--- 现有 nginx 站点文件哈希（改动前后对比用）---"
for f in /etc/nginx/sites-available/xxc2007.me /etc/nginx/nginx.conf; do
  if [[ -f "$f" ]]; then sha256sum "$f"; else echo "缺失: $f"; fi
done
echo "（记录上面的哈希；部署后 verify-deploy.sh 会再要一次基线对比）"

echo "--- 端口占用（期望 3000/3001/5432 空闲或被合法进程占用）---"
if command -v ss >/dev/null 2>&1; then
  for p in "$WEB_PORT_CHECK" "$API_PORT_CHECK" 3055 "$PG_PORT"; do
    if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; then
      echo "占用: 端口 $p -> $(ss -ltnp "sport = :$p" 2>/dev/null | awk 'NR==2{print $NF}')"
    else
      echo "空闲: 端口 $p"
    fi
  done
else
  echo "没有 ss 命令 —— 无法验证端口，跳过（★ 需人工确认）"
fi

echo "--- Docker / PostgreSQL 存在性（不要假定，逐项实测）---"
if command -v docker >/dev/null 2>&1; then echo "docker: $(docker --version)"; echo "  compose: $(docker compose version 2>/dev/null || echo 无)"; else echo "docker: 未安装"; fi
# 这一条不只是"装没装"：第 5 节决定 TRUST_PROXY 写 true 还是 false 用的就是它（前面没有反代就不能信 XFF）。
nginx_state="$(systemctl is-active nginx 2>/dev/null || true)"
nginx_enabled="$(systemctl is-enabled nginx 2>/dev/null || true)"
if command -v nginx >/dev/null 2>&1; then
  echo "nginx: $(nginx -v 2>&1)  active=${nginx_state:-未知} enabled=${nginx_enabled:-未知}"
  [[ "$nginx_state" == "active" ]] || echo "  ⚠ nginx 装了但没在跑 —— 第 5 节会因此把 TRUST_PROXY 判成 false；真是反代拓扑就 GEOHOT_TRUST_PROXY=true 显式覆盖"
else
  echo "nginx: 未安装 —— 那这台机器前面就没有反代，第 5 节把 TRUST_PROXY 写成 false（除非你用 GEOHOT_TRUST_PROXY=true 声明有别的东西在前面）"
fi
[[ -f /etc/nginx/sites-available/xxc2007.me ]] || echo "（提示：/etc/nginx/sites-available/xxc2007.me 不在 —— 上面那个哈希对比与 README-deploy.md 第 2 节 ⑦ 的贴片段都指望着它）"
if command -v psql >/dev/null 2>&1; then echo "psql: $(psql --version)"; else echo "psql: 未安装（★ pg_dump 备份路线与第 6~7 节的建角色都依赖它，见 README-deploy.md 第 6 节）"; fi
if command -v pg_dump >/dev/null 2>&1; then echo "pg_dump: $(pg_dump --version)"; else echo "pg_dump: 未安装"; fi
if systemctl is-active --quiet postgresql 2>/dev/null; then
  echo "postgresql.service: active  版本: $(su -s /bin/bash postgres -c 'psql -tAc "SELECT version()"' 2>/dev/null || psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -tAc 'SELECT version()' 2>/dev/null || echo 未知)"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
  echo "PostgreSQL: 在 $PG_HOST:$PG_PORT 应答（非 systemd 管理，★ 弄清是谁在跑）"
else
  echo "PostgreSQL: 未在 $PG_HOST:$PG_PORT 应答 —— ★ 需要先安装或让用户指明实例"
fi

echo "--- PostgreSQL 版本与 pg_trgm（database/migrations/0001_core.sql:4 要 pg_trgm；本站支持 $PG_MIN_MAJOR–$PG_MAX_MAJOR）---"
pg_major="$(pg_probe 'SHOW server_version' | cut -d. -f1 | tr -dc 0-9)"
if [[ -z "$pg_major" ]]; then
  echo "版本: 读不到（没有 psql，或部署用户不能 sudo -u postgres）—— ★ --apply 时第 6 节会实测并拒绝继续"
elif (( pg_major >= PG_MIN_MAJOR && pg_major <= PG_MAX_MAJOR )); then
  echo "版本: PostgreSQL $pg_major —— 支持（线上这台是 PGDG apt 源的 17）"
elif (( pg_major > PG_MAX_MAJOR )); then
  echo "版本: PostgreSQL $pg_major —— 比本站验证过的 $PG_MAX_MAJOR 更新；迁移大概能过，但出问题不在此包的处置范围内"
else
  echo "版本: PostgreSQL $pg_major —— ✗ 低于 $PG_MIN_MAJOR。Ubuntu 22.04 自带就是 14，本站按 16/17 验证过。"
  echo "        装 PGDG 源：https://apt.postgresql.org/  → sudo apt install postgresql-17-pgdg"
fi
if [[ -z "$pg_major" ]]; then
  echo "pg_trgm: 读不到（没有 psql，或部署用户不能 sudo -u postgres）—— 不猜，--apply 时第 6 节实测并拒绝继续"
elif [[ -n "$(pg_probe "SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm'")" ]]; then
  echo "pg_trgm: 集群里有（中文搜索与相似度归组靠它）"
else
  echo "pg_trgm: ✗ 集群里没有 —— 迁移第一步 CREATE EXTENSION pg_trgm 就会失败，而且报错很不像这个原因。"
  echo "        Ubuntu 自带的 PostgreSQL 把 contrib 拆成另一个包：sudo apt install postgresql-contrib"
  echo "        （PGDG 源的 postgresql-17-pgdg 已含 contrib，装它就行）；--apply 时第 6 节会拒绝继续"
fi
pg_locale="$(pg_probe 'SHOW lc_ctype')"
if [[ -n "$pg_locale" ]]; then
  case "$pg_locale" in
    C|POSIX) echo "lc_ctype: $pg_locale —— ⚠ 中文 similarity() 恒为 0，pg_trgm 的 GIN 索引永远匹配不到中文（README-deploy.md 第 7 节那一行）" ;;
    *)       echo "lc_ctype: $pg_locale" ;;
  esac
fi
if [[ "$(pg_probe "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'")" == "1" ]]; then
  echo "库 $PG_DATABASE 已存在 —— 第 6 节的 pg_trgm/版本检查会连到它上面再实测一次"
fi

echo "--- Node 版本（要求 >= $NODE_MIN，package.json engines）---"
if command -v node >/dev/null 2>&1; then
  node -e "const [a,b]=(process.versions.node).split('.');const [ma,mb]='$NODE_MIN'.split('.');process.exit((a>ma||(a==ma&&b>=mb))?0:1)" \
    && echo "node: $(node --version) OK" || echo "node: $(node --version) 低于 $NODE_MIN —— ★ 必须先升级，否则 npm ci 拒装"
else
  echo "node: 未安装 —— ★ 本脚本不装 Node，需人工装 24.x"
fi

echo "--- 现状存在性 ---"
for p in "$APP_HOME" "$APP_ROOT" "$ENV_PATH" "$APP_ROOT/node_modules" "$APP_ROOT/apps/web/build"; do
  [[ -e "$p" ]] && echo "存在: $p" || echo "缺失: $p"
done
for u in "${UNITS[@]}"; do
  [[ -f "/etc/systemd/system/$u.service" ]] && echo "存在: unit $u" || echo "缺失: unit $u"
done
if [[ -f "$ENV_PATH" ]]; then
  echo "--- 现有 .env 关键开关（只列键名与非机密值，上线前逐项核对 README-deploy.md 第 5 节）---"
  # .env 是 0600、属主 $APP_USER 的，而本节以**调用者**身份跑：直接 grep 会以 EACCES 失败，
  # 上一版把这种失败和"这些键真的没写"打成同一句话，把人往错的方向带。现在三种情况分开说。
  ENV_KEYS='^(NODE_ENV|AIHOT_ENVIRONMENT|SITE_URL|TRUST_PROXY|COLLECT_ENABLED|MODEL_CALLS_ENABLED|FEISHU_[A-Z_]*ENABLED|INDEXNOW_SUBMIT_ENABLED|WEB_HOST|API_HOST|DEV_AUTH_ROLE|DATABASE_URL)='
  if ! id "$APP_USER" >/dev/null 2>&1; then
    echo "(读不了：$APP_USER 用户还不存在，要等第 1 节建好 —— 这不是 .env 本身的问题)"
  elif ! "${DROP_APP[@]}" sh -c 'test -r "$1"' _ "$ENV_PATH" 2>/dev/null; then
    echo "!! 读不了：$ENV_PATH 存在，但 $APP_USER 读不到它（属主或权限不对；正常是 $APP_USER 0600）。"
    echo "   这【不是】上面那组键都没写。先修再核对："
    echo "     sudo chown $APP_USER:$APP_USER $ENV_PATH && sudo chmod 600 $ENV_PATH"
  else
    env_listing="$("${DROP_APP[@]}" grep -oE "${ENV_KEYS}[^\"]*" "$ENV_PATH" 2>/dev/null | while IFS= read -r l; do
      k="${l%%=*}"; v="${l#*=}"
      case "$k" in DATABASE_URL) v="$(mask "$v")" ;; *KEY*|*SECRET*|*PASSWORD*|ADMIN_PASSWORD|INGEST_TOKEN) v="(已写，值不打印)" ;; esac
      printf '    %s=%s\n' "$k" "$v"
    done)"
    if [[ -n "$env_listing" ]]; then printf '%s\n' "$env_listing"
    else echo "  (这些键一个都没写 —— 缺省语义见 README-deploy.md 第 5 节；$APP_USER 读得到文件，这一条是实测不是猜)"
    fi
  fi
fi

echo
echo "预检完毕。DRY-RUN 模式$([[ $APPLY == 1 ]] && echo '（--apply：下面各步将真正执行）' || echo '：以下各步只打印不执行。')"

# ----------------------------------------------------------------------------
# 1. 系统用户与应用目录
# ----------------------------------------------------------------------------
step "1. 用户 $APP_USER 与目录 $APP_HOME"
if id "$APP_USER" >/dev/null 2>&1; then
  echo "用户 $APP_USER 已存在 —— 跳过创建（幂等）"
else
  if getent group "$APP_GROUP" >/dev/null 2>&1; then echo "组 $APP_GROUP 已存在 —— 跳过"
  else run "创建系统用户组 $APP_GROUP" $SUDO groupadd --system "$APP_GROUP"
  fi
  run "创建系统用户 $APP_USER（nologin，无 home 登录）" $SUDO useradd --system --gid "$APP_GROUP" --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
fi
# 只建父目录：$APP_ROOT 由第 2 节的 clone 创建（install -d 一个将来放代码的目录会把 clone 变成非空目录报错）。
# 但 install -d -o/-g 对**已存在**的目录也会改属主与权限，而 APP_HOME 是 APP_ROOT 的父目录：
# 有人把 GEOHOT_APP_ROOT 指到 /srv/geohot 或 /var/www/app 时，这一行就会把 /srv、/var/www 整个 chown 给
# geohot —— 那台机器上别的站点立刻坏。所以：目录已经存在且不是 geohot 所有就停手，让人来决定。
if [[ -d "$APP_HOME" ]]; then
  home_owner="$(stat -c '%U:%G' "$APP_HOME" 2>/dev/null || echo 未知)"
  if [[ "$home_owner" == "$APP_USER:$APP_GROUP" ]]; then
    echo "$APP_HOME 已存在且属主已是 $APP_USER:$APP_GROUP —— 只确保权限，不动别人"
    run "chmod 750 $APP_HOME" $SUDO install -d -o "$APP_USER" -g "$APP_GROUP" -m 750 "$APP_HOME"
  else
    echo "!! $APP_HOME 已存在，属主是 $home_owner 而不是 $APP_USER:$APP_GROUP。" >&2
    echo "   本脚本不对**别人的**已有目录做 chown（GEOHOT_APP_ROOT=$APP_ROOT 的父目录就是它）。" >&2
    echo "   要么换一个 GEOHOT_APP_ROOT（默认 /opt/geohot/app），要么先人工确认这个目录归你、再手工执行：" >&2
    echo "     sudo chown $APP_USER:$APP_GROUP $APP_HOME && sudo chmod 750 $APP_HOME" >&2
    [[ "$APPLY" == "1" ]] && exit 1
  fi
else
  run "创建 $APP_HOME 并授权给 $APP_USER" $SUDO install -d -o "$APP_USER" -g "$APP_GROUP" -m 750 "$APP_HOME"
fi

# ----------------------------------------------------------------------------
# 2. 拉取代码（公开仓库）
# ----------------------------------------------------------------------------
step "2. git clone -> $APP_ROOT"
if [[ -d "$APP_ROOT/.git" ]]; then
  echo "已有 git 仓库 —— 只 fetch，不强推重置（幂等，绝不 reset --hard）"
  run "git fetch（以 $APP_USER 身份，HOME=$APP_HOME）" "${AS_APP[@]}" git -C "$APP_ROOT" fetch origin "$BRANCH"
  # rev-parse 也要以 $APP_USER 的身份跑：以调用者身份读 geohot 的仓库会被 git 的 "dubious ownership"
  # 挡下来（safe.directory），上一版把它当成"当前分支: ?"打出来，看着像分支名丢了。
  cur="$("${AS_APP[@]}" git -C "$APP_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '读不到（仓库不属于自己 / 不是 git 仓库）')"
  echo "当前分支: $cur —— 如需切到 $BRANCH，请人工确认无本地改动后执行: git -C $APP_ROOT checkout $BRANCH && git -C $APP_ROOT pull --ff-only"
else
  if [[ -e "$APP_ROOT" ]]; then
    echo "!! $APP_ROOT 已存在但不是 git 仓库 —— 拒绝覆盖，请人工处理" >&2
    exit 1
  fi
  # clone 前实测远端可达（只读）。GIT_TERMINAL_PROMPT=0 是必要的：私有仓库或没网络的机器上，
  # git 会弹一个用户名/密码提示挂在那里，--apply 就在第 2 节僵住 —— 宁可在这里停下来给离线方案。
  if command -v timeout >/dev/null 2>&1 && GIT_TERMINAL_PROMPT=0 timeout 25 git ls-remote --exit-code "$REPO_URL" "refs/heads/$BRANCH" >/dev/null 2>&1; then
    echo "  远端可达: $REPO_URL ($BRANCH)"
  elif [[ "$APPLY" == "1" ]]; then
    echo "!! clone 不了：$REPO_URL 的 $BRANCH 读不到（没网络、仓库私有、或地址不对）。" >&2
    echo "   三条出路，任选一条后重跑本脚本（幂等）：" >&2
    echo "   ① 有内网 git 就换地址:  GEOHOT_REPO_URL=<能访问到的 git url>" >&2
    echo "   ② 离线搬运（DEPLOYMENT.md「实际执行的四步」第 1 步用的就是这个）：" >&2
    echo "        git archive HEAD | gzip > geohot.tar.gz                    # 在能拉的机器上" >&2
    echo "        sudo mkdir -p $APP_ROOT && sudo tar -xzf geohot.tar.gz -C $APP_ROOT --owner=$APP_USER --group=$APP_USER" >&2
    echo "        sudo chown -R $APP_USER:$APP_USER $APP_ROOT                 # root 解出来的目录会让 npm 拿 EACCES" >&2
    echo "      然后重跑：$APP_ROOT/.git 还是没有，但代码在位 —— 用 git init + remote add 补上，或直接注释掉本节" >&2
    echo "   ③ 需要凭据：以 $APP_USER 身份配一次只读 deploy key（HOME 就是 $APP_HOME）。" >&2
    exit 1
  else
    echo "  ⚠ 现在读不到 $REPO_URL 的 $BRANCH（DRY-RUN 只警告）。--apply 到这一步会按上面的三条出路停下来。"
  fi
  run "clone -> $APP_ROOT（$APP_USER 身份，HOME=$APP_HOME）" "${AS_APP[@]}" git clone --branch "$BRANCH" "$REPO_URL" "$APP_ROOT"
fi

# ----------------------------------------------------------------------------
# 3. 依赖安装
# ----------------------------------------------------------------------------
step "3. npm ci（锁文件安装，绝不 npm install）"
# HOME 必须是 $APP_HOME：见 AS_APP 那段注释。npm 的缓存目录取自 HOME，落在 /home/<操作者> 下的话
# geohot 既写不进去也读不回来，第 9 节的构建会以 EACCES 收场（DEPLOYMENT.md 第 2 步记的就是这一组）。
run "npm ci（$APP_USER 身份，HOME=$APP_HOME，可能耗时数分钟）" \
  "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && npm ci --no-audit --no-fund"

# 构建/迁移都要能写 $APP_ROOT；顺手确认 clone 之后目录确实归 $APP_USER（root 解出来的 tar 会坏在这一步）。
if [[ -d "$APP_ROOT" ]]; then
  app_owner="$(stat -c '%U' "$APP_ROOT" 2>/dev/null || echo 未知)"
  [[ "$app_owner" == "$APP_USER" ]] || echo "⚠ $APP_ROOT 属主是 $app_owner 而不是 $APP_USER —— npm 与构建会拿 Permission denied (os error 13)：sudo chown -R $APP_USER:$APP_GROUP $APP_ROOT"
fi

# ----------------------------------------------------------------------------
# 4. 环境变量文件
# ----------------------------------------------------------------------------
step "4. .env 生成（绝不覆盖已有）"
if [[ -f "$ENV_PATH" ]]; then
  echo ".env 已存在 —— 跳过。init-env.ts 自己也拒绝覆盖（它开头的 alreadyThere 守卫：文件在就 exit 1），幂等双保险"
else
  # init-env.ts 用 node crypto.randomBytes 生成密钥并打印一次管理员密码（写在 0600 的 .env 里，见它
  # 的 writeFileSync(..., { mode: 0o600 })）；与要求的 openssl rand -hex 32 等价强度。
  run "node scripts/init-env.ts（生成 SESSION_SECRET/IMG_PROXY_SIGN_SECRET/ADMIN_PASSWORD，权限 0600）" \
    "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && node scripts/init-env.ts"
  echo "★ 记下上面打印的管理员密码，然后按需编辑 .env 落实 README-deploy.md 第 5 节的生产取值"
  echo "★ 若 init-env.ts 因缺 LLM key 退出非零：手工 cp .env.example .env 后用下面命令补密钥："
  echo "    openssl rand -hex 32   # SESSION_SECRET / IMG_PROXY_SIGN_SECRET 各一次"
fi

# ----------------------------------------------------------------------------
# 5. .env 复核与写回（★ 在任何数据库操作之前 —— 顺序不可颠倒）
# ----------------------------------------------------------------------------
step "5. .env 复核：核对完才允许碰数据库"
if [[ ! -f "$ENV_PATH" ]]; then
  echo "!! 没有 $ENV_PATH —— 第 4 节没生成成功（或者代码不在 \$GEOHOT_APP_ROOT 下）。" >&2
  echo "   继续下去每一步都会失败：先 cp .env.example .env 并填好，再来一次。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi
# env_get 是**以 $APP_USER 的身份**读 .env 的，而它把所有失败都吞成空串（|| true）。文件读不到时，
# 下面那一整组断言会齐刷刷报"每个键都没有值"—— 与"文件确实没写这些键"是两件事，必须先分开。
if [[ -f "$ENV_PATH" ]] && ! "${DROP_APP[@]}" sh -c 'test -r "$1"' _ "$ENV_PATH" 2>/dev/null; then
  echo "!! $ENV_PATH 存在但 $APP_USER 读不到（0600 的属主不对？）—— 断言读不到值不等于值没写。" >&2
  echo "   先修：sudo chown $APP_USER:$APP_USER $ENV_PATH && sudo chmod 600 $ENV_PATH" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi

# 角色口令：操作者给就用给的，没给就这里生成。生成值只写进 .env（0600）与 CREATE ROLE 的 stdin，不回显、
# 不进 argv（同机任何人 ps 一眼就能看到 psql -c 的整条语句 —— 见第 7 节）。
PG_PASSWORD="${GEOHOT_PG_PASSWORD:-}"
if [[ -n "$PG_PASSWORD" ]]; then
  pg_password_source="GEOHOT_PG_PASSWORD 给的"
else
  PG_PASSWORD="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))' 2>/dev/null || true)"
  pg_password_source="随机生成"
fi
if [[ -z "$PG_PASSWORD" ]]; then
  echo "!! 生成不了角色口令（本机没有 node？第 3 节的 npm 与第 9 节的构建同样需要它）。用 GEOHOT_PG_PASSWORD=<口令> 再跑。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi
# 字符集守卫：这一串要活过三个地方 —— CREATE ROLE 的单引号 SQL 字面量、.env 里那条
# postgres://user:PW@host:port/db、以及第 7 节临时 passfile 的冒号分隔字段。含 ' \\ " ` $ 会破 SQL，
# 含 : 会破 passfile，含 % 会被 URI 解码成别的字节，含 @ 会让"哪个 @ 之前是口令"这件事失去唯一答案，
# 空白与 shell 元字符则在 sudo/tee 那一层出事。上一版对 GEOHOT_PG_PASSWORD 一个字都不校验，
# 于是含单引号的口令会以一条看不懂的 psql 语法错收场。口令本身不打到终端，只说长度。
if [[ ! "$PG_PASSWORD" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "!! 角色口令只能由 [A-Za-z0-9._+-] 组成（长度 ${#PG_PASSWORD}，含不允许的字符；值不打印）。" >&2
  echo "   特别是 ' 与 \\ 会让第 7 节的 CREATE ROLE 语句坏掉，: 会让第 7 节的 passfile 错位，" >&2
  echo "   % 与 @ 会让 .env 的 DATABASE_URL 解析出另一个口令。" >&2
  echo "   要么换一个（推荐：干脆不设 GEOHOT_PG_PASSWORD，让本脚本随机生成），要么人工改库里的角色口令。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi

echo "--- 先写三行，再让人核对剩下的（写的都是本脚本自己要用/本拓扑必然的值，不是编辑决策）---"
# DATABASE_URL 由 PG_* 现拼并写回：以前这里只在终端打印一行"照着抄"，.env 里留的还是模板那串
# 127.0.0.1:5433 embedded —— 两边各说各话，migrate 死在连不上的库上。
if pg_admin_works && [[ "$(pg_probe "SELECT 1 FROM pg_roles WHERE rolname='$PG_ROLE'")" == "1" ]]; then
  echo "角色 $PG_ROLE 已存在 —— 不动 .env 的 DATABASE_URL（口令以 .env 现有那行为准，第 7 节实测连接）"
else
  run_secret "写 .env: DATABASE_URL=postgres://$PG_ROLE:***@$PG_HOST:$PG_PORT/$PG_DATABASE" \
    "env_set DATABASE_URL 'postgres://$PG_ROLE:***@$PG_HOST:$PG_PORT/$PG_DATABASE'" \
    env_set DATABASE_URL "postgres://$PG_ROLE:$PG_PASSWORD@$PG_HOST:$PG_PORT/$PG_DATABASE"
fi
# TRUST_PROXY 说的是"进来的请求先经过一个我信得过的反代"，它是**拓扑事实**，不是一律 true 的偏好。
# 本站确实是 nginx（同机、只听回环）+ Cloudflare，两个进程都必须信它：api 现在也读这一行
# （apps/api/src/app.ts:28 的 trustProxy，以前是写死的 true）。缺这一行 = 两个进程都不信 XFF =
# 登录与反馈限流把全体访客算成 127.0.0.1（routes/admin-auth.ts 的每地址 10 次变成全局共用）。
# 但反过来，在一台**没有**反代、把 3000/3001 直接暴露出去的机器上写 true，等于让客户端自报
# X-Forwarded-For，那两个限流当场失效（docs/deploy.md「配域名和 HTTPS」一节写的就是这个取舍）。
# 所以：显式给了就用给的；否则按第 0 节实测的 nginx 状态判；判成 false 时大声说清后果。
if [[ -n "${GEOHOT_TRUST_PROXY:-}" ]]; then
  case "$GEOHOT_TRUST_PROXY" in
    true|false) TRUST_PROXY_WANT="$GEOHOT_TRUST_PROXY"; trust_proxy_why="GEOHOT_TRUST_PROXY 显式给的" ;;
    *) echo "GEOHOT_TRUST_PROXY 只能是 true 或 false（现在是 '$GEOHOT_TRUST_PROXY'）" >&2; exit 2 ;;
  esac
elif [[ "$nginx_state" == "active" ]]; then
  TRUST_PROXY_WANT=true
  trust_proxy_why="实测 nginx.service active —— 前面确有反代"
else
  TRUST_PROXY_WANT=false
  trust_proxy_why="实测这台机器上没有在跑的 nginx.service（第 0 节），按 docs/deploy.md 的口径保持 false"
fi
if [[ "$TRUST_PROXY_WANT" == "false" ]]; then
  echo "⚠ 即将写 TRUST_PROXY=false（$trust_proxy_why）。如果前面其实有 nginx / 别的代理，"
  echo "  现在就停下：GEOHOT_TRUST_PROXY=true 重跑本脚本 —— 否则限流会把全体访客算成同一个 IP。"
  echo "  只有这台机器真的直接对外服务 3000/3001 时，false 才是对的。"
fi
run "写 .env: TRUST_PROXY=$TRUST_PROXY_WANT（$trust_proxy_why；web 与 api 两个进程都读它）" env_set TRUST_PROXY "$TRUST_PROXY_WANT"
# MODEL_CALLS_ENABLED 必须显式写：packages/backend/src/config.ts:92 的缺省是 **true**，一个没写这一行、
# 又没起 geohot-brain 的服务器会安静地对着已死的 127.0.0.1:3055 发每一次分析请求（第 10 节会装那个单元，
# 默认留 stub 所以默认 true；不留 stub 就 GEOHOT_MODEL_CALLS=false 重跑，README-deploy.md 第 5 节那条"决定 1"）。
GEOHOT_MODEL_CALLS="${GEOHOT_MODEL_CALLS:-true}"
case "$GEOHOT_MODEL_CALLS" in true|false) ;; *) echo "GEOHOT_MODEL_CALLS 只能是 true 或 false（现在是 '$GEOHOT_MODEL_CALLS'）" >&2; exit 2 ;; esac
run "写 .env: MODEL_CALLS_ENABLED=$GEOHOT_MODEL_CALLS（不给缺省兜底的机会）" env_set MODEL_CALLS_ENABLED "$GEOHOT_MODEL_CALLS"

echo "--- 逐项断言（README-deploy.md 第 5 节那张表的机器可读版）---"
ENV_PROBLEMS=()
env_check() { # env_check <KEY> <期望的正则> <说明>
  local key="$1" pattern="$2" why="$3" value shown; value="$(env_get "$key")"
  # 断言失败时要把值打出来给人看，但密钥类不能进终端与 journalctl（mask() 只认连接串那个形状）。
  case "$key" in
    *SECRET*|*PASSWORD*|*TOKEN*|*KEY*) shown="(值不打印；长度 ${#value})" ;;
    *) shown="$(mask "$value")" ;;
  esac
  if [[ -z "$value" ]]; then ENV_PROBLEMS+=("$key 没有值 —— $why"); return 0; fi
  if [[ ! "$value" =~ $pattern ]]; then ENV_PROBLEMS+=("$key=$shown 不像预期取值 —— $why"); fi
}
env_check NODE_ENV "^production$" "拒启检查 assertProductionSecrets 看的就是它（config.ts:12）"
env_check AIHOT_ENVIRONMENT "^production$" "开发免登录后门看的是它（config.ts:90），两个都要 production"
env_check SITE_URL "^https://[^ ]+$" "读者实际访问的地址；canonical/OG/RSS/sitemap/MCP 全用它（config.ts:54-68 在生产会因缺值直接拒启）"
env_check ADMIN_PASSWORD "^.{12,}$" "后台密码硬下限 12 位（admin/auth.ts:146），且不能是占位词（失败时只报长度，不报值）"
env_check SESSION_SECRET "^.{8,}$" "生产短值/占位拒启（config.ts:132）；用 openssl rand -hex 32"
env_check IMG_PROXY_SIGN_SECRET "^.{8,}$" "同上；没它文中远程图片全裂"
env_check DATABASE_URL "^postgres://$PG_ROLE:[^@]+@$PG_HOST:$PG_PORT/$PG_DATABASE$" "口令必须与第 7 节建的角色一致"
env_check TRUST_PROXY "^$TRUST_PROXY_WANT$" "本脚本刚按「$trust_proxy_why」写入；不符说明 .env 不可写或被同时改过。拓扑真变了就改 GEOHOT_TRUST_PROXY 重跑（见上一小节）"
env_check MODEL_CALLS_ENABLED "^(true|false)$" "本脚本刚写入，正常不该失败；失败说明 .env 不可写"
env_check COLLECT_ENABLED "^(true|false)$" "显式写一个值，别靠缺省（README-deploy.md 第 5 节）"

site_url="$(env_get SITE_URL)"
site_host_part="${site_url#*://}"
if [[ "$site_host_part" == */* ]]; then site_path="/${site_host_part#*/}"; else site_path=""; fi
if [[ -n "$site_url" && "$site_path" != "$GEOHOT_BASE_PATH" ]]; then
  ENV_PROBLEMS+=("SITE_URL 的路径是 '${site_path:-（域名根）}'，与本次构建前缀 '${GEOHOT_BASE_PATH:-（域名根）}' 不一致 —— 绝对链接与 bundle 会分三口话说（apps/web/server.ts:50-53 起进程也会警告这一条）")
fi
if [[ "$(env_get MODEL_CALLS_ENABLED)" == "true" ]]; then
  case "$(env_get LLM_BASE_URL)" in
    http://127.0.0.1:*|http://localhost:*|""|*127.0.0.1*) ;;
    *) echo "  · 提示：MODEL_CALLS_ENABLED=true 而 LLM_BASE_URL=$(mask "$(env_get LLM_BASE_URL)") 不是回环 —— 那就是真花钱的接口，确认这是站主的决定" ;;
  esac
fi
[[ -n "$(env_get DEV_AUTH_ROLE)" ]] && ENV_PROBLEMS+=("DEV_AUTH_ROLE 还在（="$(env_get DEV_AUTH_ROLE)"）—— 后台所有写接口等于不鉴权，整行删掉（README-deploy.md 第 5 节）")

if [[ "${#ENV_PROBLEMS[@]}" -gt 0 ]]; then
  echo "✗ .env 还有 ${#ENV_PROBLEMS[@]} 处不对："
  for problem in "${ENV_PROBLEMS[@]}"; do echo "    - $problem"; done
  echo "  改 $ENV_PATH 之后重跑本脚本（幂等：已建好的东西都跳过）。"
  [[ "$APPLY" == "1" ]] && { echo "!! 带着这些值去建角色/建库/迁移就是这次修正的起点 —— 现在停在这里。" >&2; exit 1; }
else
  echo "  ✓ 上面那些键都看着像生产取值"
fi

if [[ "$APPLY" == "1" ]]; then
  if [[ "${GEOHOT_I_REVIEWED_ENV:-}" == "1" ]]; then
    echo "GEOHOT_I_REVIEWED_ENV=1 —— 跳过交互确认（机器可读的那几项已经过了）"
  elif ! IFS= read -r -p "把 README-deploy.md 第 5 节剩下的几行（SITE_URL 之外的人工取值、LLM_API_KEY 是不是占位串）也核对完再回车继续（会开始建角色、建库、迁移）；Ctrl-C 放弃: "; then
    echo "!! 非交互终端：核对后用 GEOHOT_I_REVIEWED_ENV=1 bash bootstrap-server.sh --apply 继续。" >&2
    exit 1
  fi
else
  echo "[DRY ] --apply 时上面那组断言失败就 exit 1，并在此处等一次回车，然后才进第 6 节。"
fi

# ----------------------------------------------------------------------------
# 6. PostgreSQL 预检（版本与 pg_trgm —— 迁移失败前说清楚）
# ----------------------------------------------------------------------------
step "6. PostgreSQL 预检：版本 $PG_MIN_MAJOR–$PG_MAX_MAJOR、pg_trgm 可用"
if ! command -v psql >/dev/null 2>&1; then
  echo "!! 本机没有 psql —— 建角色/建库/迁移后验证都要它。装客户端：sudo apt install postgresql-client" >&2
  echo "   （线上那台的 PostgreSQL 17 来自 PGDG apt 源，客户端包名 postgresql-client-17-pgdg）" >&2
  [[ "$APPLY" == "1" ]] && exit 1
elif ! pg_admin_works; then
  echo "!! 不能 sudo -u postgres psql —— 部署用户没有这条 sudo 规则，第 7 节会失败（README-deploy.md 第 3 节）。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
else
  pg_major="$(pg_probe 'SHOW server_version' | cut -d. -f1 | tr -dc 0-9)"
  if [[ -z "$pg_major" ]]; then
    echo "!! 读不到 server_version —— 人工确认实例：psql -h $PG_HOST -p $PG_PORT -U postgres -tAc 'SHOW server_version'" >&2
    [[ "$APPLY" == "1" ]] && exit 1
  elif (( pg_major < PG_MIN_MAJOR || pg_major > PG_MAX_MAJOR )); then
    echo "!! PostgreSQL $pg_major 不在本站支持区间 $PG_MIN_MAJOR–$PG_MAX_MAJOR（docs/deploy.md「不用 Docker」一节第一段的版本要求）。" >&2
    echo "   Ubuntu 22.04 自带 14。装 PGDG：https://apt.postgresql.org/ → sudo apt install postgresql-17-pgdg" >&2
    [[ "$APPLY" == "1" ]] && exit 1
  else
    echo "PostgreSQL $pg_major ✓"
  fi
  if [[ -z "$(pg_probe "SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm'")" ]]; then
    echo "!! 集群里没有 pg_trgm —— database/migrations/0001_core.sql:4 是第一条迁移的第一句，" >&2
    echo "   失败信息会是 'could not open extension control file ... pg_trgm.control'，看着像权限问题。" >&2
    echo "   装 contrib：sudo apt install postgresql-contrib（Ubuntu 自带 PG 14 那条路）" >&2
    echo "   或 sudo apt install postgresql-17-pgdg（PGDG 源已含 contrib），装完再跑本脚本。" >&2
    [[ "$APPLY" == "1" ]] && exit 1
  else
    echo "pg_trgm 可用 ✓"
    # 库已存在时直接实测扩展状态（pg_available_extensions 只说明文件在，不说明能装）
    if [[ "$(pg_probe "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'")" == "1" ]]; then
      echo "  库里已装扩展: $(pg_probe "SELECT extname FROM pg_extension WHERE extname='pg_trgm'") （空=还没装，迁移的第一条会 CREATE EXTENSION）"
    fi
  fi
fi

# ----------------------------------------------------------------------------
# 7. PostgreSQL 角色与数据库（只建 geohot 自己的，绝不碰其它）
# ----------------------------------------------------------------------------
step "7. PostgreSQL：CREATE ROLE $PG_ROLE / CREATE DATABASE $PG_DATABASE"
# 上一版这里打印一句"跳过，请人工执行本节"却什么都不跳，继续往下跑 CREATE ROLE 然后死在 set -e 上。
# 第 6 节在 --apply 时已经拦过一道（它要 sudo -u postgres 可用）；这里只补 root 之外的 sudo 缺失。
if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" != "0" ]]; then
  echo "!! 既不是 root 也没有 sudo —— 本节（建角色、建库）做不了，后面的第 8 节会以连不上库收场。" >&2
  echo "   用有 sudo 的账户重跑，或人工执行本节后再跑本脚本的剩余部分。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi
role_exists() { [[ "$(pg_probe "SELECT 1 FROM pg_roles WHERE rolname='$PG_ROLE'")" == "1" ]]; }
db_exists()   { [[ "$(pg_probe "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'")" == "1" ]]; }
create_pg_role() { # SQL 走 stdin，不进 psql 的 argv：`psql -c "… PASSWORD 'xxx'"` 会让整条语句在同机
  # 任何用户的 `ps` 里出现几百毫秒。printf 是 bash 内建，口令只经管道；第 5 节已校验它不含 ' 与 \，
  # 所以字面量不需要再转义（转义规则本身才是上一版含引号口令炸掉的起因）。
  printf 'CREATE ROLE %s LOGIN PASSWORD %s;\n' "$PG_ROLE" "'$PG_PASSWORD'" \
    | "${DROP_PG[@]}" psql -q -v ON_ERROR_STOP=1 -f -
}
created_role=0
if role_exists; then echo "角色 $PG_ROLE 已存在 —— 跳过 CREATE ROLE（口令以 .env 现有那行为准，下面的连接实测会验）"
else run_secret "CREATE ROLE $PG_ROLE LOGIN（口令$pg_password_source；只经 stdin，不回显、不进 argv）" \
       "printf 'CREATE ROLE $PG_ROLE LOGIN PASSWORD <hidden>;' | ${DROP_PG[*]} psql -q -v ON_ERROR_STOP=1 -f -" \
       create_pg_role
     created_role=1
fi
if db_exists; then echo "库 $PG_DATABASE 已存在 —— 跳过 CREATE DATABASE（数据在里面，重复运行无害）"
else run "CREATE DATABASE $PG_DATABASE OWNER $PG_ROLE" "${DROP_PG[@]}" createdb -O "$PG_ROLE" "$PG_DATABASE"
fi
echo "!! 本脚本从不编辑 pg_hba.conf、从不动其它 role/database。"
echo "!! 若 CREATE ROLE 报 peer 认证错：部署用户须能 sudo -u postgres（见 README-deploy.md 第 3 节）。"

# 连接实测：用 .env 里那一行去连一次。这是"两边不可能对不上"的最后一道 —— 角色早就存在、口令却
# 不是本次生成的那种情况，只有真连一次才发现得了。
echo "--- 用 .env 的 DATABASE_URL 实测连接（只读 SELECT version()）---"
conn_url="$(env_get DATABASE_URL)"
if [[ -z "$conn_url" ]]; then
  echo "!! .env 里没有 DATABASE_URL —— 第 5 节被跳过或 .env 被清空了。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
else
  echo "  目标: $(mask "$conn_url")"
  # 第 5 节已经把口令限制在 [A-Za-z0-9._+-] 内（不含 @ : %），所以"最后一个 @ 之前是口令"这件事
  # 有唯一答案；贪婪匹配的 (.*) 取的就是最后一段。
  if [[ "$conn_url" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://[^/:]+:(.*)@[^/@]+/.*$ ]]; then conn_pw="${BASH_REMATCH[1]}"; else conn_pw=""; fi
  if [[ -z "$conn_pw" ]]; then
    echo "!! DATABASE_URL 不是 postgres://用户:口令@主机:端口/库 的形状（$(mask "$conn_url")）—— 连接实测做不了。" >&2
    [[ "$APPLY" == "1" ]] && exit 1
  elif [[ "$APPLY" == "1" ]]; then
    # 口令不进 argv：`env PGPASSWORD=xxx psql …` 的 xxx 在同机任何用户的 `ps` 里都能看到。改成写一份
    # 0600、属主 $APP_USER 的临时 passfile（mktemp 的权限就是这样），psql 只看到它的路径。用完即删，
    # 任何退出路径上都有 trap 兜着（cleanup_pgpass）。放在 $APP_HOME 而不是 /tmp，避开别人能读的目录。
    if ! PGPASS_FILE="$( "${AS_APP[@]}" mktemp "$APP_HOME/.geohot-pgpass.XXXXXX" 2>/dev/null )"; then
      echo "!! 写不了临时 passfile（$APP_HOME 不可由 $APP_USER 写？）—— 连接实测做不了。" >&2
      echo "   人工验证一条即可：sudo -u $APP_USER psql -h $PG_HOST -p $PG_PORT -U $PG_ROLE -d $PG_DATABASE -tAc 'SELECT version()'" >&2
      exit 1
    fi
    printf '%s:%s:%s:%s:%s\n' "$PG_HOST" "$PG_PORT" "$PG_DATABASE" "$PG_ROLE" "$conn_pw" \
      | "${AS_APP[@]}" tee "$PGPASS_FILE" >/dev/null
    if probe_out="$( "${AS_APP[@]}" env PGPASSFILE="$PGPASS_FILE" psql -w -h "$PG_HOST" -p "$PG_PORT" -U "$PG_ROLE" -d "$PG_DATABASE" -tAc 'SELECT version()' 2>&1 )"; then
      echo "  ✓ 连上了: ${probe_out:0:60}"
    else
      echo "!! 连不上: $probe_out" >&2
      echo "   三种可能：① 角色 $PG_ROLE 早就存在、口令与 .env 里那行不同 —— 让两者对齐（口令自己敲，别从终端历史里抄）：" >&2
      echo "     sudo -u postgres psql  →  ALTER ROLE $PG_ROLE PASSWORD '…';" >&2
      echo "   ② pg_hba.conf 不认 $PG_HOST:$PG_PORT 的口令认证（本脚本不改它，人工加一行）" >&2
      echo "   ③ 库 $PG_DATABASE 还没建或名字不同" >&2
      cleanup_pgpass
      exit 1
    fi
    cleanup_pgpass
    echo "  （临时 passfile 已删除；本脚本不在磁盘上留口令文件）"
  else
    echo "[DRY ] 写一份 0600 的 \$APP_HOME/.geohot-pgpass.XXXXXX（内容 host:port:db:user:password），然后"
    echo "[DRY ] \$ ${AS_APP[*]} env PGPASSFILE=<那份临时文件> psql -w -h $PG_HOST -p $PG_PORT -U $PG_ROLE -d $PG_DATABASE -tAc 'SELECT version()'  # 用完即删"
  fi
fi

# ----------------------------------------------------------------------------
# 8. 迁移与种子（只增不改，重复运行安全）
# ----------------------------------------------------------------------------
step "8. migrate + seed + seed:curated"
run "迁移（database/migrations 35 个，向后兼容增量）" "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && node --env-file=.env scripts/migrate.ts"
run "种子（主题 + 44 信源，ON CONFLICT DO NOTHING）"  "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && node --env-file=.env scripts/seed.ts"
run "语料 dry-run 先行" "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && npm run seed:curated -- --dry-run --enforce-source"
run "语料正式导入（重锚到当下，精选立即可见）" "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && npm run seed:curated -- --enforce-source"

# ----------------------------------------------------------------------------
# 9. 构建 web bundle（nginx 与 geohot-web 都依赖它）
# ----------------------------------------------------------------------------
step "9. npm run build -w @aihot/web（带站点前缀，跑在带 MemoryMax 的临时作用域里）"
# 前缀是构建期的事：不带 BASE_PATH 打出来的 bundle 里所有资源都写 /assets/...，而 nginx 只在
# /geohot 下面反代 —— 结果就是首页 200、每个 css/js 全 404（这次修正的第 2 条）。
# GEOHOT_BASE_PATH="" 时故意传空串：apps/web/vite.config.ts:14 把空值当域名根，域名根部署才构建得对。
#
# ★ 这一条必须待在 cgroup 上限里：这台机器实际可用 891 MB，vite 构建能吃到几百 MB，没有上限时
#   内核 OOM 挑中的很可能是 nginx / Artalk / PostgreSQL —— 主站跟着一起没。DEPLOYMENT.md
#   「实际执行的四步」第 2 步用的就是下面这条 systemd-run（900M/1500M 那一组），这里只是把它参数化。
BUILD_MEM_MAX="${GEOHOT_BUILD_MEMORY_MAX:-900M}"
BUILD_SWAP_MAX="${GEOHOT_BUILD_MEMORY_SWAP_MAX:-1500M}"
if command -v systemd-run >/dev/null 2>&1; then
  # --uid/--gid 需要 root，所以整条前面挂 $SUDO（已经是 root 时 $SUDO 为空）。
  # --pipe --wait 让它同步跑完并把构建输出接到当前终端；--property=WorkingDirectory= 不能省，
  # systemd-run 默认在 / 起进程，npm 会报 ENOENT /package.json（DEPLOYMENT.md 第 2 步记的那条）。
  run "构建前端（$APP_USER 身份，MemoryMax=$BUILD_MEM_MAX，BASE_PATH='${GEOHOT_BASE_PATH}'；产物 apps/web/build/client 供 server.ts:21 静态服务）" \
    $SUDO systemd-run --quiet --pipe --wait --uid "$APP_USER" --gid "$APP_GROUP" \
      --property="MemoryMax=$BUILD_MEM_MAX" --property="MemorySwapMax=$BUILD_SWAP_MAX" \
      --property="WorkingDirectory=$APP_ROOT" \
      env "HOME=$APP_HOME" "BASE_PATH=$GEOHOT_BASE_PATH" "NODE_ENV=production" npm run build -w @aihot/web
elif [[ "${GEOHOT_ALLOW_UNCAPPED_BUILD:-}" == "1" ]]; then
  echo "!! 本机没有 systemd-run，按 GEOHOT_ALLOW_UNCAPPED_BUILD=1 的授权裸跑构建 —— OOM 可能波及 nginx/Artalk/PostgreSQL。" >&2
  run "构建前端（无内存上限，已显式授权）" \
    "${AS_APP[@]}" bash -c "cd '$APP_ROOT' && BASE_PATH='${GEOHOT_BASE_PATH}' NODE_ENV=production npm run build -w @aihot/web"
else
  echo "!! 本机没有 systemd-run，没法把构建关进一个带 MemoryMax 的作用域。" >&2
  echo "   裸跑 vite 在这台 891 MB 的机器上可能连带杀掉 nginx / Artalk / PostgreSQL（那就是主站挂了）。" >&2
  echo "   两条路：① 人工跑 DEPLOYMENT.md「实际执行的四步」第 2 步那条 systemd-run；" >&2
  echo "   ② 确实明白风险，就 GEOHOT_ALLOW_UNCAPPED_BUILD=1 重跑本脚本。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
  echo "[DRY ] 预检环境（比如开发机）常见没有 systemd-run，故 DRY-RUN 只警告不退出。"
fi
echo "  前缀已烧进 bundle：改前缀 = 重新构建 + 换 nginx 前缀 + 改 SITE_URL，三处一起（README-deploy.md 第 10 节）"

# ----------------------------------------------------------------------------
# 10. 安装 systemd 单元
# ----------------------------------------------------------------------------
step "10. systemd 单元（四个）"
if [[ -d "$SYSTEMD_SRC" ]]; then
  for u in "${UNITS[@]}"; do
    src="$SYSTEMD_SRC/$u.service" dst="/etc/systemd/system/$u.service"
    if [[ ! -f "$src" ]]; then echo "!! 缺少 $src"; exit 1; fi
    # 单元里的 WorkingDirectory / EnvironmentFile / ReadWritePaths 写死的是默认安装路径（systemd 在这里
    # 没有变量插值可用）。换过 GEOHOT_APP_ROOT 就不要装这些模板 —— 用 bash install-units.sh，它按变量渲染。
    if [[ "$APP_ROOT" != "/opt/geohot/app" ]] && ! grep -qF "$APP_ROOT" "$src"; then
      echo "!! $src 里的路径与 GEOHOT_APP_ROOT=$APP_ROOT 不一致 —— 改用 bash install-units.sh 渲染，或改模板" >&2
      [[ "$APPLY" == "1" ]] && exit 1
    fi
    if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
      echo "unit $u 已一致 —— 跳过"
    else
      run "安装/更新 $u.service" $SUDO install -m 644 "$src" "$dst"
    fi
  done
  run "daemon-reload" $SUDO systemctl daemon-reload
  run "enable 四个 unit（暂不 --now：先人工核对 .env 再 start）" $SUDO systemctl enable "${UNITS[@]}"
  echo "核对无误后手工: sudo systemctl start ${UNITS[*]}（顺序 brain → api → worker → web）"
  echo "（刻意不把 nginx 操作放进本脚本 —— 见 geohot.nginx.conf片段 的 ADD/回滚流程）"
else
  # 上一版这里打印"跳过 systemd 安装"就继续往下走，最后打印"完成"。第 10 节被跳过的机器上，
  # verify-deploy.sh 第 2 节会红着问"四个单元在哪"，而没人知道是没装还是没启动。装包目录里没有
  # systemd/ 通常是拷贝时漏了子目录（README-deploy.md 第 8 节让整目录拷到 ~/.deploy）。
  echo "!! 未找到 $SYSTEMD_SRC —— 四个单元一个都没装。" >&2
  echo "   补齐本目录（deploy/geohot/ 连同它的 systemd/ 子目录一起拷），或改用 bash install-units.sh 渲染安装。" >&2
  [[ "$APPLY" == "1" ]] && exit 1
fi

step "完成。下一步：按 geohot.nginx.conf片段 头部那四条硬约束与 README-deploy.md 第 2 节的 ⑦ 贴 nginx 片段"
echo "（前缀 ${GEOHOT_BASE_PATH:-（域名根，无需 location）}；备份 → 注入 → nginx -t 通过才 reload，绝不 restart）"
echo "然后：sudo systemctl start ${UNITS[*]} → bash verify-deploy.sh 全绿。"
echo "★ 如果还没跑过 bash verify-deploy.sh --save-baseline：它必须在**任何 nginx 改动之前**跑，现在补已经晚了（见 README-deploy.md 第 1 节）。"
