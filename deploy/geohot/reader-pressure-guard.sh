#!/bin/bash
# Before optional historical collection, give readers priority. Never change the R115 state.
set -eu
if [[ -r /run/geohot-r115-gate ]]; then
 read -r until _ </run/geohot-r115-gate || true
 if [[ "${until:-0}" =~ ^[0-9]+$ ]] && (( until > $(date +%s) )); then
  echo 'reader-pressure-guard: waiting for existing R115 cooldown'; exit 1
 fi
fi
awk '/^full / {split($2,a,"="); if(a[2]>10) exit 1}' /proc/pressure/memory
awk '/^full / {split($2,a,"="); if(a[2]>10) exit 1}' /proc/pressure/io
