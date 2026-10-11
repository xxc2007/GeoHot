#!/usr/bin/env bash
# Private migration bundle: source, database, persistent files and service configuration.
set -euo pipefail
umask 077
APP=${GEOHOT_APP_ROOT:-/opt/geohot/app}
DEST=${GEOHOT_BACKUP_ROOT:-/opt/geohot/backups/migration}
STATE_DIR=${GEOHOT_ARCHIVE_STATE_DIR:-$APP/.data/archive-cycle}
mkdir -p "$DEST"
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
5. Update .env database/site URLs, production secrets and host allowlists for the destination.
6. Run migrations, build web with BASE_PATH matching the destination (current /geohot).
7. Adapt the included systemd and nginx configuration; restore archive-cycle.conf to /etc/geohot/ (0600, geohot ownership), then test nginx before starting services and the archive timer.
8. Run deploy/geohot/verify-deploy.sh and scripts/smoke.ts, then verify reader pages, feeds and report references.
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
