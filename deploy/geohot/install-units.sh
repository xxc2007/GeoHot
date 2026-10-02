#!/usr/bin/env bash
# Writes the four long-lived systemd units for the /geohot/ deployment and reloads systemd.
# Written after the first deployment attempt failed on three things, all of which are fixed here:
#   1. the units pointed at a checkout that does not exist — see APP_ROOT below, both this script and the
#      templates under systemd/ now take the one install path variable (GEOHOT_APP_ROOT);
#   2. every unit needs HOME=/opt/geohot (the geohot account has no login shell) and an absolute
#      --env-file path — a relative one resolves against the unit's own WorkingDirectory and the unit
#      crash-loops with "node: .env: not found";
#   3. each unit carries a MemoryMax so an OOM inside GEOHOT cannot take nginx or Artalk with it —
#      that is the whole point of running a second service on a 900 MB box.
#
# These are the minimal units the live box actually runs. deploy/geohot/systemd/*.service are the same
# four units plus a hardening block (ProtectSystem=strict, ReadWritePaths, …) — bootstrap-server.sh step 10
# installs those. Pick one route per box; both read the same GEOHOT_APP_ROOT, and both keep the MemoryMax.
#
# Run as a user with sudo. Idempotent: it overwrites the unit files, which is the point.
set -euo pipefail
# One install path for the whole deploy package (bootstrap / install-units / verify-deploy / rollback and
# the systemd/ templates all default to this value). Override with GEOHOT_APP_ROOT=/other/path.
APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
APP_HOME="${APP_ROOT%/*}"          # /opt/geohot — HOME= for the units (the geohot account has none)

# The editorial-brain stub. It is load-bearing here: config.ts:92 defaults MODEL_CALLS_ENABLED to true, so
# a box without this process makes every analysis call against a dead 127.0.0.1:3055 and reports nothing.
# bootstrap-server.sh step 5 writes that valve into .env explicitly; this unit is the other leg of the deal.
sudo tee /etc/systemd/system/geohot-brain.service >/dev/null <<UNIT
[Unit]
Description=GEOHOT editorial brain (local OpenAI-compatible stub, 127.0.0.1:3055)
After=network.target

[Service]
User=geohot
Group=geohot
WorkingDirectory=$APP_ROOT
EnvironmentFile=$APP_ROOT/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=$APP_HOME
Environment=BRAIN_PORT=3055
MemoryMax=160M
MemorySwapMax=400M
ExecStart=/usr/bin/node tooling/brain-stub.ts
Restart=on-failure
RestartSec=5
# The worker drains in-flight jobs on stop; systemd's 90 s default SIGKILLs mid-drain, which is the
# outcome-unknown path (a job that ran but never recorded). Give every unit the worker's budget.
TimeoutStopSec=210

[Install]
WantedBy=multi-user.target
UNIT

for n in api worker web; do
  wd="$APP_ROOT"; [ "$n" = web ] && wd="$APP_ROOT/apps/web"
  max=240M; [ "$n" = web ] && max=320M; [ "$n" = api ] && max=200M
  case "$n" in
    api)    tag="GEOHOT api (Fastify, 127.0.0.1:3001)"; exec="/usr/bin/node --env-file=.env apps/api/src/main.ts"; after="postgresql.service geohot-brain.service"; host="Environment=API_HOST=127.0.0.1";;
    worker) tag="GEOHOT worker (pg-boss queues + schedules; SINGLE INSTANCE ONLY)"; exec="/usr/bin/node --env-file=.env apps/worker/src/main.ts"; after="postgresql.service geohot-brain.service"; host="";;
    web)    tag="GEOHOT web (SSR, 127.0.0.1:3000)"; exec="/usr/bin/node --env-file=$APP_ROOT/.env server.ts"; after="geohot-api.service"; host="Environment=WEB_HOST=127.0.0.1";;
  esac
  # No BASE_PATH here on purpose: apps/web/server.ts:46-49 takes the prefix from the built bundle, so a
  # runtime Environment=BASE_PATH= line is inert — editing it and restarting changes nothing. The prefix is
  # a build-time variable (bootstrap-server.sh step 9: BASE_PATH='${GEOHOT_BASE_PATH}' npm run build).
  sudo tee /etc/systemd/system/geohot-$n.service >/dev/null <<UNIT
[Unit]
Description=$tag
After=network.target $after

[Service]
User=geohot
Group=geohot
WorkingDirectory=$wd
EnvironmentFile=$APP_ROOT/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=$APP_HOME
Environment=TZ=Asia/Shanghai
$host
MemoryMax=$max
MemorySwapMax=600M
ExecStart=$exec
Restart=on-failure
RestartSec=5
# The worker drains in-flight jobs on stop; systemd's 90 s default SIGKILLs mid-drain, which is the
# outcome-unknown path (a job that ran but never recorded). Give every unit the worker's budget.
TimeoutStopSec=210

[Install]
WantedBy=multi-user.target
UNIT
done

sudo systemctl daemon-reload
echo "installed: $(systemctl list-unit-files 'geohot*' --no-legend | wc -l) units (want 4, APP_ROOT=$APP_ROOT)"
echo "the site prefix is baked into the web bundle — rebuild with BASE_PATH if it changes, do not edit these units"
echo "enable+start with: sudo systemctl enable --now geohot-brain geohot-api geohot-worker geohot-web"
