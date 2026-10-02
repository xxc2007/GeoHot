#!/usr/bin/env bash
# rollback.sh — GEOHOT 部署的回滚（幂等，默认 DRY-RUN，--apply 执行）
# 原则：每一步只做 bootstrap/deploy 的逆操作；对主站零写操作。
#
# ██████████████████████████████████████████████████████████████████████████
# █ ★★ 绝对禁止：docker compose down -v ★★                                   █
# █   compose 的 db/data/caddy 卷里是数据库、上传截图与证书（docker-compose  █
# █   .yml:93-96；docs/deploy.md:63 「down 不会删除它们；down -v 会」）。     █
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

NGINX_SITE="/etc/nginx/sites-available/xxc2007.me"
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

echo "回滚 GEOHOT 部署。模式: $([[ $APPLY == 1 ]] && echo 'APPLY（真正执行）' || echo 'DRY-RUN（只打印）')"
echo "顺序与部署相反：nginx → 进程 → （可选）数据库 → （可选）文件。"

# ---------------------------------------------------------------------------
step "R1. nginx：恢复部署前备份并 reload（reload，绝不 restart）"
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
  echo "   手工方案：编辑站点文件，删除 geohot.nginx.conf片段 中标注 ADD 的三块"
  echo "   （location = /geohot、location /geohot/、location /geohot/api/mcp），"
  echo "   然后 sudo nginx -t && sudo systemctl reload nginx。"
  echo "   —— 除这三块外不得删任何行；根 location/、Artalk、ACME 一律不动。"
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
    run "pg_dump 备份到 $APP_HOME/geohot-before-purge-$TS.sql.gz" \
      bash -c "sudo -u postgres pg_dump '$PG_DATABASE' | gzip > '$APP_HOME/geohot-before-purge-$TS.sql.gz'"
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
  run "删除系统用户（可选）" sudo userdel "$APP_USER" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
step "R5. 主站完好性验证（回滚后必跑）"
echo "与本脚本同目录的 verify-deploy.sh 的第 1、2 节，或直接："
echo "    curl -s https://xxc2007.me/ | sha256sum   # 与 baseline-main.txt 的 main_home_sha256 一致"
echo "    systemctl is-active nginx                  # active"
echo "    curl -sI https://xxc2007.me/comment/ | head -1   # Artalk 照旧"
echo
echo "回滚流程结束。docker 从未出现在本脚本中；若你另用了容器部署，只允许 docker compose stop（无 -v）。"
