#!/usr/bin/env bash
# Private migration bundle: source, database, persistent files and service configuration.
set -euo pipefail
umask 077
APP=${GEOHOT_APP_ROOT:-/opt/geohot/app}
DEST=${GEOHOT_BACKUP_ROOT:-/opt/geohot/backups/migration}
STATE_DIR=${GEOHOT_ARCHIVE_STATE_DIR:-$APP/.data/archive-cycle}
mkdir -p "$DEST"
# 空间预检。备份要同时占着三份磁盘：暂存目录里的 database.dump + application.tgz，和最后那个
# portable.tgz。写到一半才 ENOSPC 会留下一个"打完了"的残缺包——这台机 / 是 62 G、备份目录已经
# 攒到 16 G（#148），所以这不是理论风险。估法不猜数字：拿本机最近一个成功包的实际体积当基准，
# 要求可用空间至少是它的 2.5 倍；一个包都还没有时按 4 GB 兜底。
NEED_KB=$(find "$DEST" -maxdepth 1 -name 'geohot-*-portable.tgz' -printf '%s\n' 2>/dev/null \
  | awk 'BEGIN{m=0}{if($1>m)m=$1}END{printf "%d", int(m/1024)}')
if [[ -z "$NEED_KB" || "$NEED_KB" -lt 1048576 ]]; then NEED_KB=4194304; fi
AVAIL_KB=$(df -Pk "$DEST" | awk 'NR==2{print $4}')
if [[ "$AVAIL_KB" -lt $((NEED_KB * 5 / 2)) ]]; then
  printf 'not enough free space on %s: %s KB available, need about %s KB (largest previous bundle x2.5)\n' \
    "$DEST" "$AVAIL_KB" "$((NEED_KB * 5 / 2))" >&2
  printf 'free some room in %s first — old bundles are yours to delete, this script will not\n' "$DEST" >&2
  exit 1
fi
# Keep archive checkpoints behind the database snapshot they describe. The normal worker can
# continue: pg_dump supplies a consistent database snapshot, and its image caches are excluded.
command -v flock >/dev/null || { printf 'flock is required for a consistent archive snapshot\n' >&2; exit 2; }
mkdir -p "$STATE_DIR"
exec 8>"$STATE_DIR/cycle.lock"
flock -w 120 8 || { printf 'Archive collection is busy; backup deferred\n' >&2; exit 2; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "$DEST/.portable-$STAMP-XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT
cd "$APP"
export GEOHOT_DUMP_PATH="$WORK/database.dump"
node --env-file=.env --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
const u = new URL(process.env.DATABASE_URL);
execFileSync('pg_dump', ['--format=custom','--no-owner','--no-acl','--file',process.env.GEOHOT_DUMP_PATH], {
  env: { ...process.env, PGHOST:u.hostname, PGPORT:u.port || '5432', PGDATABASE:decodeURIComponent(u.pathname.slice(1)),
    PGUSER:decodeURIComponent(u.username), PGPASSWORD:decodeURIComponent(u.password) }, stdio:'inherit' });
NODE
pg_restore --list "$WORK/database.dump" > "$WORK/database-contents.txt"
tar -czf "$WORK/application.tgz" --exclude='./node_modules' --exclude='./.git' \
  --exclude='./.data' --exclude='./.pgdata' --exclude='./apps/web/build' --exclude='./apps/web/.react-router' \
  --exclude='./apps/web/node_modules' --exclude='./apps/api/node_modules' --exclude='./apps/worker/node_modules' .
if [[ -d .data ]]; then
  tar -czf "$WORK/persistent-data.tgz" --exclude='./imgcache' --exclude='./ogcache' --exclude='./backups' -C .data .
fi
# 凭据与配置文件可以刻意住在 $APP 之外，而 application.tgz 收的只有 $APP —— 于是"可随时迁移部署"
# 的那个包里少的是**整条链路**。2026-10-12 实测就是这一种：WorkBuddy 桥的凭据在
#   /opt/geohot/workbuddy-credential.json（0600 geohot，.env 的 WORKBUDDY_CREDENTIAL_JSON 指着它），
# 桥现在承担这台机器上约七成八的判定调用，照旧包恢复出来的新机是"活着但不判定"的站，
# 而包里没有任何东西会说这件事。
# 做法不写死文件名：凡是 .env 里"绝对路径、是普通文件、且在 $APP 之外"的值都收进来，
# 以后再加一份外置凭据不需要回来改这里。原名记在 PATHS.txt 里，恢复时按原路径摆回去。
EXTRA="$WORK/outside-app"
mkdir -p "$EXTRA"
: > "$EXTRA/PATHS.txt"
if [[ ! -r "$APP/.env" ]]; then
  printf 'cannot read %s/.env — run this as root (sudo bash), the bundle needs it\n' "$APP" >&2
  exit 1
fi
# 解析不偷懒。这份 .env 是从 Windows scp 上来的：`export KEY=`、`KEY="value"`、行尾 `# 注释`、
# 行尾空格、CRLF 全都真实存在过。第一版用一条 sed 只认 `KEY=/abs` 这一种形状，后果是一对镜像的错：
# 那种行被**静默跳过**（包里没有凭据、PATHS.txt 里没有它、一声不响），而同一条形状喂给下面那道
# "凭据必须在场"的守卫时又判成缺失，整场备份拒绝运行。一个形状两种错，所以逐行解析。
# 每行输出 `键名<TAB>值`，值已经去掉 export、引号、行尾注释、尾部空白与 CR。
env_pairs() {
  local line key v
  while IFS= read -r line; do
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[2]}; v=${BASH_REMATCH[3]}
    v=${v%%[[:space:]]#*}
    v="${v%"${v##*[![:space:]]}"}"
    v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    printf '%s\t%s\n' "$key" "$v"
  done < "$APP/.env"
}
while IFS=$'\t' read -r key p; do
  [[ -f "$p" ]] || continue
  # application.tgz 收 $APP 整棵（排除 .data/.pgdata 与缓存、build），persistent-data.tgz 收 .data
  # 里除 imgcache/ogcache/backups 之外的部分。只有"两边都不带"的路径才需要在这里补收——
  # 否则住在 $APP/.data/imgcache 里的凭据会既不在那两个 tar 里、又被上一版那行跳过，静默丢掉。
  case "$p" in
    "$APP"/*) case "$p" in "$APP/.data/"*|"$APP/.pgdata/"*) ;; *) continue ;; esac ;;
  esac
  name=$(basename "$p")
  if [[ -e "$EXTRA/$name" ]]; then
    # 两把键指着不同目录里的同名文件时，cp 会安静地盖掉前一份，PATHS.txt 于是两行都"对"，
    # 恢复时按哪一行都不完整。用上级目录名区分开；还撞就停。
    name="$(basename "$(dirname "$p")")--$name"
    [[ -e "$EXTRA/$name" ]] && { printf 'cannot name both %s and the file already collected as %s\n' "$p" "$name" >&2; exit 1; }
  fi
  cp "$p" "$EXTRA/$name"
  printf '%s\t%s\n' "$name" "$p" >> "$EXTRA/PATHS.txt"
  printf 'collected file the app tarballs would not carry: %s  (%s)\n' "$p" "$key"
done < <(env_pairs | awk -F'\t' '$2 ~ /^\//' | LC_ALL=C sort -u -t$'\t' -k2,2)

# 关键链路不许变成"看不见的缺口"：.env 指着凭据而文件不在，就判备份失败，而不是打出一个恢复不出来的包。
CRED=$(env_pairs | awk -F'\t' '$1 == "WORKBUDDY_CREDENTIAL_JSON" || $1 == "WORKBUDDY_CREDENTIAL" { print $2; exit }')
if [[ -n "$CRED" && ! -f "$CRED" ]]; then
  printf '%s is configured in .env but missing — the bundle would restore a site with no judging bridge\n' "$CRED" >&2
  exit 1
fi
mkdir "$WORK/systemd"
# 单元清单不手写。手写那一份是 `geohot-brain api worker web archive archive.timer` 六个名字，
# WorkBuddy 桥（`geohot-workbuddy`，现在承担约七成八的判定调用）加进来之后它没跟着改——
# 于是"可随时迁移部署"的那个包里根本没有这条链路，新机器照包恢复出来是一个静默少一个进程的站。
# 现在收这台机器上实际存在的每一个 geohot-* 单元，以后加单元不需要再回来改这一行。
mapfile -t UNITS < <(systemctl list-unit-files 'geohot*' --no-legend | awk '{print $1}')
# 但"全自动收集"不能替掉"关键链路必须在"：少一个单元时这包照样打得出来，只是恢复之后停摆。
# 所以核心那五个还是逐个点名，缺一个就把备份判失败，而不是让它成为一个看不见的缺口。
for must in geohot-brain.service geohot-api.service geohot-worker.service geohot-web.service geohot-archive.timer; do
  [[ " ${UNITS[*]} " == *" $must "* ]] \
    || { printf 'geohot 单元 %s 不在本机 —— 备份中止（要么它该被装上，要么先改这份清单并写清为什么）\n' "$must" >&2; exit 1; }
done
printf '收录单元：%s\n' "${UNITS[*]}"
for unit in "${UNITS[@]}"; do
  if systemctl cat "$unit" > "$WORK/systemd/$unit.txt" 2>/dev/null; then :; else rm "$WORK/systemd/$unit.txt"; fi
done
[[ ! -f /etc/nginx/sites-available/xxc2007.me ]] || cp /etc/nginx/sites-available/xxc2007.me "$WORK/nginx-site.conf"
[[ ! -f /etc/geohot/archive-cycle.conf ]] || cp /etc/geohot/archive-cycle.conf "$WORK/archive-cycle.conf"
[[ ! -f /opt/geohot/archive-status.json ]] || cp /opt/geohot/archive-status.json "$WORK/archive-status.json"
node --version > "$WORK/runtime.txt"
npm --version >> "$WORK/runtime.txt"
pg_dump --version >> "$WORK/runtime.txt"
cat > "$WORK/RESTORE.txt" <<'TEXT'
This bundle contains private environment credentials. Keep it outside web roots and public repositories.
1. Install the recorded Node major version and PostgreSQL 17+, create a geohot service account and database.
2. Extract application.tgz into /opt/geohot/app. Install dependencies with npm ci.
3. Restore database.dump using pg_restore --no-owner --no-acl into the new empty database.
4. Extract persistent-data.tgz into app/.data if present. Set geohot ownership and protect .env (0600).
5. Restore every file named in outside-app/PATHS.txt back to the absolute path in the second column
   (they live outside the app root, e.g. the WorkBuddy bridge credential). Without them the site starts
   and stays quiet: the judging bridge has no credential and the model calls silently stop. 0600, geohot.
6. Update .env database/site URLs, production secrets and host allowlists for the destination.
7. Run migrations, build web with BASE_PATH matching the destination (current /geohot).
8. Adapt the included systemd and nginx configuration; restore archive-cycle.conf to /etc/geohot/ (0600, geohot ownership), then test nginx before starting services and the archive timer.
9. Run deploy/geohot/verify-deploy.sh and scripts/smoke.ts, then verify reader pages, feeds and report references.
The database includes original materials, analyses, revisions, publications, sources and queue state.
Reusable image caches and dependencies are excluded and regenerated. A successful archive listing is not a restore drill.
TEXT
(cd "$WORK" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
OUT="$DEST/geohot-$STAMP-portable.tgz"
tar -czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
tar -tzf "$OUT" >/dev/null
printf 'Verified private migration bundle: %s\n' "$OUT"
