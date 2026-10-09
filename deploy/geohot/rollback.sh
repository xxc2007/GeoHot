#!/usr/bin/env bash
# rollback.sh — GEOHOT 部署的回滚（幂等，默认 DRY-RUN，--apply 执行）
# 原则：每一步只做 bootstrap/deploy 的逆操作；对主站零写操作。
#
# 可用环境变量（与 bootstrap-server.sh / fix-bare-path.sh 同一套，默认值 = 这台机器上的真实取值）：
#   GEOHOT_APP_ROOT=/opt/geohot/app                    安装目录（unit 文件、备份文件的位置）
#   GEOHOT_NGINX_SITE=/etc/nginx/sites-available/xxc2007.me
#                                                      ★ 主站 nginx 站点文件——换域名就改这一个变量。
#                                                         R1 那步是 `cp -a <备份> <站点文件>`：路径写死的话，
#                                                         搬到新域名时它会去覆盖一个不存在的文件、
#                                                         新域名的站点配置永远回滚不掉（这就是"搬家必崩"那条）。
#   GEOHOT_BASE_PATH=/geohot                           本次部署的 location 前缀（R1 找不到备份时，
#                                                         手工删哪三块的提示按这个前缀印；根路径部署写空串）
#   MAIN_SITE=https://xxc2007.me                       主站地址（R5 那组验证命令按它印）
#
# ██████████████████████████████████████████████████████████████████████████
# █ ★★ 绝对禁止：docker compose down -v ★★                                   █
# █   compose 的 db/data/caddy 卷里是数据库、上传截图与证书（卷配置见 docker-  █
# █   compose.yml；禁令的出处是 docs/deploy.md「备份」一节末尾那句「down 不会  █
# █   删除它们；down -v 会」）。                                               █
# █   本脚本不含任何 docker 命令；即便将来用容器部署，回滚也只用             █
# █   docker compose stop/down（无 -v）。                                    █
# █ 数据库侧：只 DROP geohot 自己的库和角色，且先备份；绝不触碰 postgres     █
# █ 集群里的其它 database/role（Artalk 是 SQLite 不受影响，但假设不成立时    █
# █ 这个约束仍然兜底）。                                                     █
# █████████████████████████████████████████████████══════════════════════════
set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --purge-database) PURGE=1 ;;
    *) echo "未知参数: $arg（可用: --apply [--purge-database]）" >&2; exit 2 ;;
  esac
done
PURGE="${PURGE:-0}"

# 主站 nginx 站点文件：与 bootstrap-server.sh / fix-bare-path.sh 同一个变量、同一个默认值。
# 以前这一行是硬编码，而本脚本 R1 用 cp -a 往它写内容 —— 换域名时那一条会把备份写进一个**别人家**的
# 站点文件（或者干脆 no such file），回滚这一步在新域名上根本走不通。
NGINX_SITE="${GEOHOT_NGINX_SITE:-/etc/nginx/sites-available/xxc2007.me}"
PREFIX="${GEOHOT_BASE_PATH-/geohot}"          # `-` 而不是 `:-`：空串合法（域名根部署）
PREFIX="${PREFIX%/}"; [[ -n "$PREFIX" ]] && PREFIX="/${PREFIX#/}"
MAIN="${MAIN_SITE:-https://xxc2007.me}"
APP_USER="geohot"
# One install path for the whole deploy package (GEOHOT_APP_ROOT — bootstrap / install-units /
# verify-deploy and the systemd/ templates all default to this same value).
APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
APP_HOME="${APP_ROOT%/*}"                    # /opt/geohot —— 备份文件落这里，不在代码目录里
UNITS=(geohot-brain geohot-api geohot-worker geohot-web)
PG_DATABASE="geohot"
PG_ROLE="geohot"
TS="$(date +%F-%H%M)"

run() { local d="$1"; shift
  if [[ "$APPLY" == "1" ]]; then echo "[APPLY] $d"; "$@"; else echo "[DRY ] $d"; echo "       \$ $*"; fi
}
step() { echo; echo "==== $* ===="; }
# R1 是本脚本唯一会覆盖系统文件的一步（cp -a <备份> <站点文件>），而它的目标现在来自变量。
# 两道硬守卫 + 一句提醒：必须绝对路径、必须不在 git 仓库里；不在常见 nginx 配置目录下只警告，
# 因为源码装的 nginx（/usr/local/nginx）与测试用的临时路径都是合法取值。
# "不在仓库里"那一条是这次加的规矩：安装目录本身就是一个 git checkout（APP_ROOT），搬家时有人会把
# 站点配置拷进仓库再让变量指过去，那样 `cp -a` 会拿一份备份去覆盖受版本控制的文件。
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)"
assert_site_path() {
  case "$NGINX_SITE" in
    /*) ;;
    *) echo "!! GEOHOT_NGINX_SITE='$NGINX_SITE' 不是绝对路径 —— R1 要 cp -a 覆盖它，相对路径会落在 \$PWD 里。" >&2; exit 2 ;;
  esac
  if [[ -n "$REPO_ROOT" && "$NGINX_SITE" == "$REPO_ROOT"/* ]]; then
    echo "!! GEOHOT_NGINX_SITE='$NGINX_SITE' 在 git 仓库里（$REPO_ROOT）—— 拒绝把备份 cp -a 到受版本控制的文件上。" >&2
    exit 2
  fi
  case "$NGINX_SITE" in
    /etc/nginx/*|/usr/local/nginx/*|/opt/nginx/*) ;;
    *) echo "⚠ GEOHOT_NGINX_SITE='$NGINX_SITE' 不在 nginx 的常见配置目录（/etc/nginx、/usr/local/nginx、/opt/nginx）下面 —— 继续，但请确认这是你要的那个站点文件（默认值 /etc/nginx/sites-available/xxc2007.me，换域名就改这一个变量）。" ;;
  esac
}
assert_site_path

echo "回滚 GEOHOT 部署。模式: $([[ $APPLY == 1 ]] && echo 'APPLY（真正执行）' || echo 'DRY-RUN（只打印）')"
echo "三个坐标（都与 bootstrap-server.sh 同一套变量，默认值 = 这台机器上的真实取值）:"
echo "  站点文件 $NGINX_SITE · 前缀 ${PREFIX:-（空 = 域名根）} · 安装目录 $APP_ROOT · 主站 $MAIN"
echo "顺序与部署相反：nginx → 进程 → （可选）数据库 → （可选）文件。"

# ---------------------------------------------------------------------------
step "R1. nginx：恢复部署前备份并 reload（reload，绝不 restart）"
echo "站点文件: $NGINX_SITE （GEOHOT_NGINX_SITE，换域名就改这一个变量）"
bak=$(ls -1 "${NGINX_SITE}.bak-"* 2>/dev/null | tail -1 || true)
if [[ -n "$bak" ]]; then
  echo "找到备份: $bak"
  run "恢复站点文件" sudo cp -a "$bak" "$NGINX_SITE"
  if [[ "$APPLY" == "1" ]]; then
    if sudo nginx -t; then
      run "reload nginx" sudo systemctl reload nginx
    else
      echo "!! nginx -t 在恢复备份后仍不通过 —— 这与 GEOHOT 无关，是站点本身坏了。停止操作，人工排查。" >&2
      exit 1
    fi
  else
    echo "[DRY ] \$ sudo nginx -t && sudo systemctl reload nginx"
  fi
else
  echo "!! 未找到 ${NGINX_SITE}.bak-* 备份。"
  # 名字要跟 geohot.nginx.conf片段 里真正写的那三块一致 —— 上一版写的是 `location /geohot/` 与
  # `location /geohot/api/mcp`，站点文件里根本没有这两个串（真实的是 `^~` 那两条），照着一份对不上
  # 名字的清单去删，很容易删错行。前缀也不许再写死：它必须等于本次构建的 GEOHOT_BASE_PATH。
  echo "   手工方案：编辑站点文件（$NGINX_SITE），删除 geohot.nginx.conf片段 中标注 ADD 的三块（名字按片段原文）："
  if [[ -n "$PREFIX" ]]; then
    echo "     location = $PREFIX { return 308 https://\$host$PREFIX/; }"
    echo "     location ^~ $PREFIX { … }"
    echo "     location ^~ $PREFIX/api/mcp { … }"
    echo "   —— $PREFIX 必须等于本次构建的 GEOHOT_BASE_PATH（默认 /geohot）；两处（:80 与 :443 两个 server 块）都要删。"
  else
    echo "     —— 本次是域名根部署（GEOHOT_BASE_PATH=\"\"）：片段那三块 location 本来就不该存在，"
    echo "        要撤的是把 / 反代到 127.0.0.1:3000 的那一组 proxy_* 行，对照你当初贴进去的那一份删。"
  fi
  echo "   —— 除这三块外不得删任何行；根 location/、Artalk、ACME 一律不动。"
  echo "   改完: sudo nginx -t && sudo systemctl reload nginx（reload，绝不 restart）"
fi

# ---------------------------------------------------------------------------
step "R2. systemd：停用并移除四个 unit（不碰 nginx/artalk 的服务）"
# 停用顺序与启动相反：web → worker → api → brain（api/worker 的 After= 里点了 geohot-brain）。
for u in geohot-web geohot-worker geohot-api geohot-brain; do
  if systemctl list-unit-files "$u.service" >/dev/null 2>&1 && [[ -n "$(systemctl list-unit-files "$u.service" --no-legend 2>/dev/null)" ]]; then
    run "stop+disable $u" sudo systemctl disable --now "$u"
  else
    echo "$u 未安装 —— 跳过"
  fi
done
if [[ "$PURGE" == "1" ]]; then
  for u in "${UNITS[@]}"; do
    run "删除 unit 文件 $u" sudo rm -f "/etc/systemd/system/$u.service"
  done
  run "daemon-reload" sudo systemctl daemon-reload
else
  echo "（unit 文件保留在 /etc/systemd/system/，重启用: sudo systemctl enable --now ${UNITS[*]}；彻底删请加 --purge-database 一并处理或手工删）"
fi

# ---------------------------------------------------------------------------
step "R3. PostgreSQL：默认什么都不做（保留数据就是保留回滚余地）"
if [[ "$PURGE" == "1" ]]; then
  echo "!! --purge-database：将删除库 $PG_DATABASE 与角色 $PG_ROLE。先备份再删。"
  if command -v pg_dump >/dev/null 2>&1; then
    # 这一条以前是 `bash -c "sudo -u postgres pg_dump … | gzip > 文件"`，两个毛病：
    # ① 新起的 bash 没有 pipefail，pg_dump 失败时 gzip 照样退出 0 —— 于是"强制备份"写下一个
    #    **空文件**，脚本继续往下 DROP DATABASE；② 那个重定向是**发起命令的人**的权限，
    #    /opt/geohot 归 geohot 所有，非特权操作者在真正 --apply 时根本写不进去。
    # 现在整条都在 sudo 里跑，并且要求产物非空才继续。
    run "pg_dump 备份到 $APP_HOME/geohot-before-purge-$TS.sql.gz" \
      sudo bash -c "set -euo pipefail; sudo -u postgres pg_dump '$PG_DATABASE' | gzip > '$APP_HOME/geohot-before-purge-$TS.sql.gz'; test -s '$APP_HOME/geohot-before-purge-$TS.sql.gz'"
    echo "   这一份就是以后恢复的输入 —— 用法见 README-deploy.md 第 6.1 节（恢复），别把它留在服务器上就忘了。"
  else
    echo "!! 没有 pg_dump —— 拒绝在无法备份时删库。先装 postgresql-client 再来。" >&2
    exit 1
  fi
  # 只动 geohot 自己的对象：先反查确认目标名精确等于 geohot，再删。
  run "DROP DATABASE geohot（仅连接数确认无其它使用者）" \
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$PG_DATABASE\""
  run "DROP ROLE geohot" sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE \"$PG_ROLE\""
  echo "已只删除 $PG_DATABASE/$PG_ROLE。pg_hba.conf 从未被本部署修改，因此也无需回滚它。"
else
  echo "数据库保留。如确认永久废弃：本脚本加 --purge-database（会先强制 pg_dump 备份）。"
fi

# ---------------------------------------------------------------------------
step "R4. 文件系统：默认保留 $APP_ROOT（代码/构建物/.data 都是可重用的）"
if [[ "$PURGE" == "1" ]]; then
  echo "如要删除应用目录，请人工检查 .data/（反馈截图、图片缓存）后自行执行："
  echo "    sudo rm -rf $APP_ROOT   # ← 本脚本不代你做这一步"
  # 原来这一行是 `run … sudo userdel "$APP_USER" 2>/dev/null || true`：run 用 "$@" 执行，
  # `2>/dev/null` 于是是**传给 userdel 的参数**（userdel 报多余操作数），而末尾的 `|| true`
  # 把这句报错连同"用户其实没删掉"一起吞了。现在先查在不在，报错就让它报错。
  if id "$APP_USER" >/dev/null 2>&1; then
    run "删除系统用户 $APP_USER（家目录不动）" sudo userdel "$APP_USER"
  else
    echo "$APP_USER 用户不存在 —— 跳过"
  fi
fi

# ---------------------------------------------------------------------------
step "R5. 主站完好性验证（回滚后必跑）"
echo "与本脚本同目录的 verify-deploy.sh 的第 1、2 节，或直接："
echo "    curl -s $MAIN/ | sha256sum   # 与 baseline-main.txt 的 main_home_sha256 一致"
echo "    systemctl is-active nginx                  # active"
echo "    curl -sI $MAIN/comment/ | head -1   # Artalk 照旧"
echo "（主站地址来自 MAIN_SITE，默认 https://xxc2007.me —— 与 bootstrap/verify 的默认值同一套，换域名改它。）"
echo "★ 新机器/新域名：baseline-main.txt 里那份哈希属于**采集它时的那个主站**。回滚前后都要按新主站重采一次"
echo "  （MAIN_SITE=<新主站> bash verify-deploy.sh --save-baseline），否则 verify 第 1 节会一直红。"
echo
echo "回滚流程结束。docker 从未出现在本脚本中；若你另用了容器部署，只允许 docker compose stop（无 -v）。"
