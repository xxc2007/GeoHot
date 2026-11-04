#!/bin/bash
# No paid calls or DB scans. Require two consecutive healthy minute samples.
set -euo pipefail
state=${R115_READY_STATE:-/run/geohot-r115-ready}
healthy=1
awk '/^MemAvailable:/ {ok=($2>=98304)} END {exit !ok}' /proc/meminfo || healthy=0
awk '/^full / {split($2,a,"=");ok=(a[2]<10)} END {exit !ok}' /proc/pressure/memory || healthy=0
awk '/^full / {split($2,a,"=");ok=(a[2]<30)} END {exit !ok}' /proc/pressure/io || healthy=0
# Reader request stays local and has a strict timeout; never traverses model routes.
curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:3000/geohot/ || healthy=0
now=$(date +%s)
prior=0
[[ ! -r "$state" ]] || read -r prior < "$state"
[[ "$prior" =~ ^[0-9]+$ ]] || prior=0
if [[ "$healthy" != 1 ]]; then rm -f -- "$state"; exit 1; fi
printf '%s\n' "$now" > "$state"
(( prior > 0 && now-prior >= 40 && now-prior <= 150 ))
