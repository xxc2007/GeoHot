#!/usr/bin/env bash
# Writes the four long-lived systemd units for the /geohot/ deployment and reloads systemd.
# Written after the first deployment attempt failed on three things, all of which are fixed here:
#   1. the units pointed at /opt/geohot/GEOHOT, but the code lives at /opt/geohot/app;
#   2. every unit needs HOME=/opt/geohot (the geohot account has no login shell) and an absolute
#      --env-file path — a relative one resolves against the unit's own WorkingDirectory and the unit
#      crash-loops with "node: .env: not found";
#   3. each unit carries a MemoryMax so an OOM inside GEOHOT cannot take nginx or Artalk with it —
#      that is the whole point of running a second service on a 900 MB box.
#
# Run as a user with sudo. Idempotent: it overwrites the unit files, which is the point.
set -euo pipefail
APP=/opt/geohot/app

sudo tee /etc/systemd/system/geohot-brain.service >/dev/null <<'UNIT'
[Unit]
Description=GEOHOT editorial brain (local OpenAI-compatible stub, 127.0.0.1:3055)
After=network.target

[Service]
User=geohot
Group=geohot
WorkingDirectory=/opt/geohot/app
EnvironmentFile=/opt/geohot/app/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=/opt/geohot
MemoryMax=160M
MemorySwapMax=400M
ExecStart=/usr/bin/node tooling/brain-stub.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

for n in api worker web; do
  wd="$APP"; [ "$n" = web ] && wd="$APP/apps/web"
  max=240M; [ "$n" = web ] && max=320M; [ "$n" = api ] && max=200M
  case "$n" in
    api)    tag="GEOHOT api (Fastify, 127.0.0.1:3001)"; exec="/usr/bin/node --env-file=.env apps/api/src/main.ts"; after="postgresql.service geohot-brain.service"; host="Environment=API_HOST=127.0.0.1";;
    worker) tag="GEOHOT worker (pg-boss queues + schedules; SINGLE INSTANCE ONLY)"; exec="/usr/bin/node --env-file=.env apps/worker/src/main.ts"; after="postgresql.service geohot-brain.service"; host="";;
    web)    tag="GEOHOT web (SSR, 127.0.0.1:3000)"; exec="/usr/bin/node --env-file=/opt/geohot/app/.env server.ts"; after="geohot-api.service"; host="Environment=WEB_HOST=127.0.0.1";;
  esac
  sudo tee /etc/systemd/system/geohot-$n.service >/dev/null <<UNIT
[Unit]
Description=$tag
After=network.target $after

[Service]
User=geohot
Group=geohot
WorkingDirectory=$wd
EnvironmentFile=/opt/geohot/app/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=/opt/geohot
Environment=TZ=Asia/Shanghai
Environment=BASE_PATH=/geohot
$host
MemoryMax=$max
MemorySwapMax=600M
ExecStart=$exec
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
done

sudo systemctl daemon-reload
echo "installed: $(systemctl list-unit-files 'geohot*' --no-legend | wc -l) units"
echo "enable+start with: sudo systemctl enable --now geohot-brain geohot-api geohot-worker geohot-web"
