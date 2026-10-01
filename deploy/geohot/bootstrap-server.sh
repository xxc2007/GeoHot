#!/usr/bin/env bash
# bootstrap-server.sh — GEOHOT 服务器一次性初始化（幂等，默认 DRY-RUN）
# 用法:
#   bash bootstrap-server.sh                # DRY-RUN：只打印将发生什么
#   bash bootstrap-server.sh --apply        # 真正执行
#   bash bootstrap-server.sh --apply --i-know-what-im-doing   # 以 root 身份执行（不推荐；脚本会 sudo -u 降权）
# 每一步都有守卫：重复运行不会覆盖已有 .env、不会重建已存在的库、不会二次 clone。
set -euo pipefail

# ----------------------------------------------------------------------------
# 配置（按服务器实况改）
# ----------------------------------------------------------------------------
APP_USER="geohot"
APP_GROUP="geohot"
APP_ROOT="/opt/geohot"
REPO_DIR="${APP_ROOT}/GEOHOT"
REPO_URL="${GEOHOT_REPO_URL:-https://github.com/xxc2007/GeoHot.git}"   # ★ 占位远端，公开仓库建好后替换
BRANCH="${GEOHOT_BRANCH:-main}"
PG_DATABASE="geohot"
PG_ROLE="geohot"
PG_HOST="127.0.0.1"
PG_PORT="5432"                 # 系统 PostgreSQL 缺口口；★ 预检会实测，本机开发那套是 5433 embedded，不要混
WEB_PORT_CHECK="3000"
API_PORT_CHECK="3001"
NODE_MIN="24.11"               # package.json engines ">=24.11"（实测文件：GEOHOT/package.json:9）
SYSTEMD_SRC="$(cd "$(dirname "$0")" && pwd)/systemd"

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
step() { echo; echo "==== $* ===="; }

# ----------------------------------------------------------------------------
# 0. 预检（只读，永远执行，打印事实而不是假设）
# ----------------------------------------------------------------------------
step "0. PREFLIGHT（只读探测）"

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
if command -v psql >/dev/null 2>&1; then echo "psql: $(psql --version)"; else echo "psql: 未安装（★ pg_dump 备份路线依赖它，见 README-deploy.md 备份一节）"; fi
if command -v pg_dump >/dev/null 2>&1; then echo "pg_dump: $(pg_dump --version)"; else echo "pg_dump: 未安装"; fi
if systemctl is-active --quiet postgresql 2>/dev/null; then
  echo "postgresql.service: active  版本: $(su -s /bin/bash postgres -c 'psql -tAc "SELECT version()"' 2>/dev/null || psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -tAc 'SELECT version()' 2>/dev/null || echo 未知)"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
  echo "PostgreSQL: 在 $PG_HOST:$PG_PORT 应答（非 systemd 管理，★ 弄清是谁在跑）"
else
  echo "PostgreSQL: 未在 $PG_HOST:$PG_PORT 应答 —— ★ 需要先安装或让用户指明实例"
fi

echo "--- Node 版本（要求 >= $NODE_MIN，package.json engines）---"
if command -v node >/dev/null 2>&1; then
  node -e "const [a,b]=(process.versions.node).split('.');const [ma,mb]='$NODE_MIN'.split('.');process.exit((a>ma||(a==ma&&b>=mb))?0:1)" \
    && echo "node: $(node --version) OK" || echo "node: $(node --version) 低于 $NODE_MIN —— ★ 必须先升级，否则 npm ci 拒装"
else
  echo "node: 未安装 —— ★ 本脚本不装 Node，需人工装 24.x"
fi

echo "--- 现状存在性 ---"
for p in "$APP_ROOT" "$REPO_DIR" "$REPO_DIR/.env" "$REPO_DIR/node_modules" "$REPO_DIR/apps/web/build"; do
  [[ -e "$p" ]] && echo "存在: $p" || echo "缺失: $p"
done
for u in geohot-api geohot-worker geohot-web; do
  [[ -f "/etc/systemd/system/$u.service" ]] && echo "存在: unit $u" || echo "缺失: unit $u"
done
if [[ -f "$REPO_DIR/.env" ]]; then
  echo "--- 现有 .env 关键开关（只列键名与值，上线前逐项核对 README-deploy.md 第 5 节）---"
  grep -E '^(NODE_ENV|AIHOT_ENVIRONMENT|SITE_URL|TRUST_PROXY|COLLECT_ENABLED|MODEL_CALLS_ENABLED|FEISHU_[A-Z_]*ENABLED|INDEXNOW_SUBMIT_ENABLED|WEB_HOST|API_HOST)=' "$REPO_DIR/.env" || echo "(以上键一个都没有 —— 缺省语义见 README-deploy.md)"
fi

echo
echo "预检完毕。DRY-RUN 模式$([[ $APPLY == 1 ]] && echo '（--apply：下面各步将真正执行）' || echo '：以下各步只打印不执行。')"

# ----------------------------------------------------------------------------
# 1. 系统用户与应用目录
# ----------------------------------------------------------------------------
step "1. 用户 $APP_USER 与目录 $APP_ROOT"
if id "$APP_USER" >/dev/null 2>&1; then
  echo "用户 $APP_USER 已存在 —— 跳过创建（幂等）"
else
  if getent group "$APP_GROUP" >/dev/null 2>&1; then echo "组 $APP_GROUP 已存在 —— 跳过"
  else run "创建系统用户组 $APP_GROUP" $SUDO groupadd --system "$APP_GROUP"
  fi
  run "创建系统用户 $APP_USER（nologin，无 home 登录）" $SUDO useradd --system --gid "$APP_GROUP" --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
fi
run "创建 $APP_ROOT 并授权" $SUDO install -d -o "$APP_USER" -g "$APP_GROUP" -m 750 "$APP_ROOT"

# ----------------------------------------------------------------------------
# 2. 拉取代码（公开仓库）
# ----------------------------------------------------------------------------
step "2. git clone -> $REPO_DIR"
if [[ -d "$REPO_DIR/.git" ]]; then
  echo "已有 git 仓库 —— 只 fetch，不强推重置（幂等，绝不 reset --hard）"
  run "git fetch（以 $APP_USER 身份）" $SUDO -u "$APP_USER" git -C "$REPO_DIR" fetch origin "$BRANCH"
  cur=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  echo "当前分支: $cur —— 如需切到 $BRANCH，请人工确认无本地改动后执行: git -C $REPO_DIR checkout $BRANCH && git -C $REPO_DIR pull --ff-only"
else
  if [[ -e "$REPO_DIR" ]]; then
    echo "!! $REPO_DIR 已存在但不是 git 仓库 —— 拒绝覆盖，请人工处理" >&2
    exit 1
  fi
  run "clone（占位远端：$REPO_URL）" $SUDO -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# ----------------------------------------------------------------------------
# 3. 依赖安装
# ----------------------------------------------------------------------------
step "3. npm ci（锁文件安装，绝不 npm install）"
run "npm ci（$APP_USER 身份，可能耗时数分钟）" $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && npm ci --no-audit --no-fund"

# ----------------------------------------------------------------------------
# 4. 环境变量文件
# ----------------------------------------------------------------------------
step "4. .env 生成（绝不覆盖已有）"
if [[ -f "$REPO_DIR/.env" ]]; then
  echo ".env 已存在 —— 跳过。scripts/init-env.ts 本身也拒绝覆盖（scripts/init-env.ts:6-9，幂等双保险）"
else
  # init-env.ts 用 openssl 之外的 randomBytes 生成密钥并打印一次管理员密码；
  # 与要求的 openssl rand -hex 32 等价强度（node crypto.randomBytes(32)）。
  run "node scripts/init-env.ts（生成 SESSION_SECRET/IMG_PROXY_SIGN_SECRET/ADMIN_PASSWORD，权限 0600）" \
    $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && node scripts/init-env.ts"
  echo "★ 记下上面打印的管理员密码，然后按需编辑 .env 落实 README-deploy.md 第 5 节的生产取值"
  echo "★ 若 init-env.ts 因缺 LLM key 退出非零：手工 cp .env.example .env 后用下面命令补密钥："
  echo "    openssl rand -hex 32   # SESSION_SECRET / IMG_PROXY_SIGN_SECRET 各一次"
fi

# ----------------------------------------------------------------------------
# 5. PostgreSQL 角色与数据库（只建 geohot 自己的，绝不碰其它）
# ----------------------------------------------------------------------------
step "5. PostgreSQL：CREATE ROLE $PG_ROLE / CREATE DATABASE $PG_DATABASE"
if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" != "0" ]]; then echo "无 sudo 且非 root —— 跳过，请人工执行本节"; fi
role_exists() { $SUDO -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_ROLE'" | grep -q 1; }
db_exists()   { $SUDO -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'" | grep -q 1; }
if role_exists; then echo "角色 $PG_ROLE 已存在 —— 跳过 CREATE ROLE"
else run "CREATE ROLE $PG_ROLE LOGIN" $SUDO -u postgres psql -c "CREATE ROLE $PG_ROLE LOGIN PASSWORD 'CHANGE_ME_bootstrap'"
fi
if db_exists; then echo "库 $PG_DATABASE 已存在 —— 跳过 CREATE DATABASE（数据在里面，重复运行无害）"
else run "CREATE DATABASE $PG_DATABASE OWNER $PG_ROLE" $SUDO -u postgres createdb -O "$PG_ROLE" "$PG_DATABASE"
fi
echo "!! 本脚本从不编辑 pg_hba.conf、从不动其它 role/database。"
echo "!! 若 CREATE ROLE 报 peer 认证错：部署用户须能 sudo -u postgres（见 README-deploy.md 第 3 节）。"
echo "!! 密码 CHANGE_ME_bootstrap 是占位 —— 执行 --apply 前用 openssl rand -hex 16 生成并替换，然后同步进 .env 的 DATABASE_URL："
echo "   DATABASE_URL=postgres://$PG_ROLE:<密码>@$PG_HOST:$PG_PORT/$PG_DATABASE"

# ----------------------------------------------------------------------------
# 6. 迁移与种子（只增不改，重复运行安全）
# ----------------------------------------------------------------------------
step "6. migrate + seed + seed:curated"
run "迁移（database/migrations 35 个，向后兼容增量）" $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && node --env-file=.env scripts/migrate.ts"
run "种子（主题 + 44 信源，ON CONFLICT DO NOTHING）"  $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && node --env-file=.env scripts/seed.ts"
run "语料 dry-run 先行" $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && npm run seed:curated -- --dry-run --enforce-source"
run "语料正式导入（重锚到当下，精选立即可见）" $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && npm run seed:curated -- --enforce-source"

# ----------------------------------------------------------------------------
# 7. 构建 web bundle（nginx 与 geohot-web 都依赖它）
# ----------------------------------------------------------------------------
step "7. npm run build -w @aihot/web"
run "构建前端（apps/web/build/client 供 server.ts:21 静态服务）" $SUDO -u "$APP_USER" bash -c "cd '$REPO_DIR' && npm run build -w @aihot/web"

# ----------------------------------------------------------------------------
# 8. 安装 systemd 单元
# ----------------------------------------------------------------------------
step "8. systemd 单元"
if [[ -d "$SYSTEMD_SRC" ]]; then
  for u in geohot-api geohot-worker geohot-web; do
    src="$SYSTEMD_SRC/$u.service" dst="/etc/systemd/system/$u.service"
    if [[ -f "$src" ]]; then
      if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
        echo "unit $u 已一致 —— 跳过"
      else
        run "安装/更新 $u.service" $SUDO install -m 644 "$src" "$dst"
      fi
    else
      echo "!! 缺少 $src"; exit 1
    fi
  done
  run "daemon-reload" $SUDO systemctl daemon-reload
  run "enable 三个 unit（暂不 --now：先人工核对 .env 再 start）" $SUDO systemctl enable geohot-api geohot-worker geohot-web
  echo "核对无误后手工: sudo systemctl start geohot-api geohot-worker geohot-web"
  echo "（刻意不把 nginx 操作放进本脚本 —— 见 geohot.nginx.conf片段 的 ADD/回滚流程）"
else
  echo "!! 未找到 $SYSTEMD_SRC —— 跳过 systemd 安装"
fi

step "完成。下一步：按 README-deploy.md 第 3 节顺序贴 nginx 片段 → 启动服务 → bash verify-deploy.sh"
